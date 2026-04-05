/**
 * Resume suggestion clustering.
 *
 * Converts granular work-log candidate strings into higher-signal thematic
 * clusters so the downstream LLM sees "resume-worthy themes" instead of
 * isolated micro-changes.
 */

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "onto", "over", "under",
  "after", "before", "this", "that", "these", "those", "today", "work",
  "worked", "working", "task", "tasks", "issue", "issues", "change", "changes",
  "flow", "module", "screen", "page", "logic", "data", "system", "support",
  "update", "updated", "using", "used", "build", "built", "made", "make",
  "하는", "했다", "합니다", "대응", "작업", "수정", "개선", "관련", "처리", "기능",
  "구현", "적용", "추가", "정리", "기반", "통해", "위해", "대한", "및", "에서", "으로"
]);

const STRONG_TOKENS = new Set([
  "android", "ios", "webview", "sentry", "oauth", "auth", "security",
  "release", "deploy", "qa", "safearea", "edge", "performance", "automation",
  "analytics", "llm", "rag", "milvus", "ecs", "sqs", "docker", "redis",
  "postgresql", "mysql", "flutter", "react", "next", "vue", "nuxt"
]);

const THEME_PATTERNS = [
  { label: "mobile stability", patterns: [/android/i, /ios/i, /webview/i, /safe\s?area/i, /edge[- ]to[- ]edge/i, /sentry/i, /flutter/i] },
  { label: "release delivery", patterns: [/release/i, /deploy/i, /\bqa\b/i, /\bship/i, /\blaunch/i, /\bversion\b/i, /\b\d+\.\d+\.\d+(?:\+\d+)?\b/] },
  { label: "security and auth", patterns: [/oauth/i, /\bauth/i, /security/i, /xss/i, /token/i, /login/i] },
  { label: "automation", patterns: [/automation/i, /auto/i, /pipeline/i, /batch/i, /workflow/i, /ci/i, /cd/i, /harness/i] },
  { label: "backend and infra", patterns: [/ecs/i, /sqs/i, /docker/i, /redis/i, /postgres/i, /mysql/i, /\bapi\b/i, /backend/i, /cloud/i] },
  { label: "frontend ux", patterns: [/react/i, /next/i, /vue/i, /nuxt/i, /ux/i, /ui/i, /design[- ]system/i] },
  { label: "data and analytics", patterns: [/analytics/i, /metric/i, /dashboard/i, /chart/i, /tracking/i, /query/i, /\bdb\b/i] },
  { label: "ai systems", patterns: [/\bllm\b/i, /\brag\b/i, /prompt/i, /embedding/i, /milvus/i, /inference/i] }
];

const LOW_SIGNAL_PATTERNS = [
  /\btypo\b/i,
  /\blint\b/i,
  /\bcomment(?:ed)?\b/i,
  /\brename(?:d)?\b/i,
  /\brefactor\b/i,
  /\bformat(?:ted)?\b/i,
  /\b\d+\.\d+\.\d+(?:\+\d+)?\b/,
  /\bversion\s*\d+\.\d+\.\d+(?:\+\d+)?\b/i,
  /^\d+\.\d+\.\d+(?:\+\d+)?$/,
];

const IMPACT_PATTERNS = [
  /stability/i, /reliability/i, /performance/i, /automation/i, /launch/i, /release/i,
  /security/i, /delivery/i, /quality/i, /improv/i, /reduce/i, /increase/i, /migrate/i,
  /optimi/i, /shipp/i, /deploy/i, /안정/i, /출시/i, /자동화/i, /성능/i, /보안/i,
  /개선/i, /최적화/i, /운영/i, /배포/i,
];

export function clusterResumeCandidateStrings(strings = []) {
  const items = strings
    .map((text) => _buildItem(text))
    .filter((item) => item.text);

  if (items.length === 0) return [];

  const parent = items.map((_, idx) => idx);

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (_shouldCluster(items[i], items[j])) {
        _union(parent, i, j);
      }
    }
  }

  const byRoot = new Map();
  for (let i = 0; i < items.length; i++) {
    const root = _find(parent, i);
    const list = byRoot.get(root) || [];
    list.push(items[i]);
    byRoot.set(root, list);
  }

  return [...byRoot.values()]
    .map((members) => _buildCluster(members))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

function _buildCluster(members) {
  const sorted = [...members].sort((a, b) => b.score - a.score);
  const themes = _collectThemes(sorted);
  const clusterScore = sorted.reduce((sum, item) => sum + item.score, 0);
  const hasStrongEvidence = sorted.some((item) => item.score >= 2);

  if (sorted.length === 1 && sorted[0].lowSignal && !hasStrongEvidence) {
    return null;
  }

  const themeLabel = _selectThemeLabel(themes, sorted);
  const evidence = _pickEvidence(sorted);
  const prompt = sorted.length === 1
    ? sorted[0].text
    : `Resume theme: ${themeLabel}. Related evidence: ${evidence.join(" | ")}`;

  return {
    theme: themeLabel,
    candidates: sorted.map((item) => item.text),
    prompt,
    score: clusterScore
  };
}

function _buildItem(text) {
  const raw = typeof text === "string" ? text.trim() : "";
  const normalized = _normalize(raw);
  const tokens = _extractTokens(raw);
  const themes = _detectThemes(raw);
  const score = _scoreSignal(raw, themes);

  return {
    text: raw,
    normalized,
    tokens,
    themes,
    score,
    lowSignal: _isLowSignal(raw, score)
  };
}

function _shouldCluster(a, b) {
  const sharedThemes = [...a.themes].filter((theme) => b.themes.has(theme));
  const overlap = _tokenOverlap(a.tokens, b.tokens);
  const strongOverlap = [...overlap].some((token) => STRONG_TOKENS.has(token));

  if (sharedThemes.length > 0 && (overlap.size >= 1 || a.score >= 2 || b.score >= 2)) {
    return true;
  }

  if (overlap.size >= 2) return true;
  if (strongOverlap && overlap.size >= 1) return true;
  return false;
}

function _collectThemes(items) {
  const counts = new Map();
  for (const item of items) {
    for (const theme of item.themes) {
      counts.set(theme, (counts.get(theme) || 0) + 1);
    }
  }
  return counts;
}

function _selectThemeLabel(themeCounts, items) {
  if (themeCounts.size > 0) {
    return [...themeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([theme]) => theme)
      .join(" + ");
  }

  const tokenCounts = new Map();
  for (const item of items) {
    for (const token of item.tokens) {
      if (STOPWORDS.has(token)) continue;
      tokenCounts.set(token, (tokenCounts.get(token) || 0) + 1);
    }
  }
  const tokenLabel = [...tokenCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([token]) => token)
    .join(" / ");

  return tokenLabel || "durable product impact";
}

function _pickEvidence(items) {
  const ranked = [...items]
    .sort((a, b) => b.score - a.score || b.text.length - a.text.length)
    .map((item) => item.text);

  return ranked.slice(0, 3);
}

function _scoreSignal(text, themes) {
  let score = 0;
  if (text.length >= 48) score += 1;
  if (themes.size > 0) score += 1;
  if (IMPACT_PATTERNS.some((pattern) => pattern.test(text))) score += 2;
  if (STRONG_TOKENS.size > 0 && [..._extractTokens(text)].some((token) => STRONG_TOKENS.has(token))) {
    score += 1;
  }
  return score;
}

function _isLowSignal(text, score) {
  if (score >= 2) return false;
  return LOW_SIGNAL_PATTERNS.some((pattern) => pattern.test(text));
}

function _detectThemes(text) {
  const themes = new Set();
  for (const { label, patterns } of THEME_PATTERNS) {
    if (patterns.some((pattern) => pattern.test(text))) {
      themes.add(label);
    }
  }
  return themes;
}

function _extractTokens(text) {
  const matches = text.toLowerCase().match(/[a-z0-9.+/-]+|[가-힣]{2,}/g) || [];
  return new Set(
    matches.filter((token) => !STOPWORDS.has(token) && !_isWeakToken(token))
  );
}

function _isWeakToken(token) {
  if (!token) return true;
  if (/^\d+$/.test(token)) return true;
  if (/^\d+\.\d+\.\d+(?:\+\d+)?$/.test(token)) return true;
  if (token.length <= 2 && !/[가-힣]/.test(token)) return true;
  return false;
}

function _tokenOverlap(a, b) {
  const overlap = new Set();
  for (const token of a) {
    if (b.has(token)) overlap.add(token);
  }
  return overlap;
}

function _normalize(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[.,\-–—&]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function _find(parent, x) {
  if (parent[x] !== x) parent[x] = _find(parent, parent[x]);
  return parent[x];
}

function _union(parent, a, b) {
  const ra = _find(parent, a);
  const rb = _find(parent, b);
  if (ra !== rb) parent[rb] = ra;
}
