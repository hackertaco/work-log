/**
 * Post-generation compression for work-log suggestions.
 *
 * The upstream pipeline still emits bullet-granular suggestions, but the UI
 * benefits from showing only the strongest representatives per company/project.
 * This module clusters near-duplicate append_bullet suggestions and keeps the
 * broadest, highest-signal representatives.
 */

const IMPACT_PATTERNS = [
  /안정/i, /품질/i, /효율/i, /정렬/i, /개선/i, /향상/i, /강화/i, /완화/i,
  /자연스럽/i, /일관성/i, /운영/i, /출시/i, /릴리스/i, /흐름/i, /경험/i,
  /stability/i, /quality/i, /efficiency/i, /consisten/i, /reliab/i, /delivery/i,
  /reduce/i, /improv/i, /optimi/i, /launch/i, /release/i, /workflow/i
];

const BROADNESS_PATTERNS = [
  /함께/i, /정리해/i, /재정비/i, /재구성/i, /구조를/i, /흐름/i, /로드맵/i,
  /운영/i, /콘텐츠/i, /experience/i, /workflow/i, /pipeline/i, /together/i
];

const CODEY_PATTERNS = [
  /\bbeforeSend\b/, /\bFinalRewriter\b/, /\bIndexedDB\b/, /\bWebView\b/,
  /\b[A-Za-z]+\.[A-Za-z]+\b/, /\bPhase\s+\d+\b/i, /\bWeek\s+\d+\b/i,
  /\b\d+\.\d+\.\d+(?:\+\d+)?\b/
];

const THEME_PATTERNS = [
  { label: "mobile", patterns: [/android/i, /ios/i, /webview/i, /safe\s?area/i, /sentry/i, /flutter/i] },
  { label: "release", patterns: [/release/i, /deploy/i, /launch/i, /version/i, /qa/i, /릴리스/i, /배포/i] },
  { label: "content", patterns: [/curriculum/i, /survey/i, /roadmap/i, /콘텐츠/i, /커리큘럼/i, /설문/i, /학습/i, /브랜드/i] },
  { label: "narrative", patterns: [/story/i, /timeline/i, /rewriter/i, /blueprint/i, /서사/i, /소설/i, /중복/i] },
  { label: "ops", patterns: [/ci/i, /sentry/i, /운영/i, /노이즈/i, /필터/i, /rebranding/i, /리브랜딩/i] },
];

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "into", "today", "work", "worked",
  "issue", "issues", "change", "changes", "flow", "system", "using", "used",
  "했습니다", "했다", "합니다", "관련", "정리", "적용", "추가", "개선", "기반",
  "대응", "작업", "및", "에서", "으로", "하게", "더", "했다", "했다."
]);

const DEFAULT_MAX_PER_ENTITY = 2;

export function compressWorkLogSuggestions(suggestions, options = {}) {
  if (!Array.isArray(suggestions) || suggestions.length === 0) return [];

  const maxPerEntity = Number.isInteger(options.maxPerEntity)
    ? options.maxPerEntity
    : DEFAULT_MAX_PER_ENTITY;

  const preserved = [];
  const groups = new Map();

  for (const suggestion of suggestions) {
    if (!_isCompressibleBulletSuggestion(suggestion)) {
      preserved.push(suggestion);
      continue;
    }

    const entityId = _getEntityId(suggestion);
    if (!entityId) {
      preserved.push(suggestion);
      continue;
    }

    const key = `${suggestion.section || "experience"}::${entityId}`;
    const list = groups.get(key) || [];
    list.push(suggestion);
    groups.set(key, list);
  }

  const compressed = [];
  for (const list of groups.values()) {
    compressed.push(..._compressEntitySuggestions(list, maxPerEntity));
  }

  return [...preserved, ...compressed];
}

function _compressEntitySuggestions(suggestions, maxPerEntity) {
  if (suggestions.length <= 1) return suggestions;

  const items = suggestions.map((suggestion) => ({
    suggestion,
    text: _getSuggestionText(suggestion),
    tokens: _extractTokens(_getSuggestionText(suggestion)),
    themes: _detectThemes(_getSuggestionText(suggestion)),
    score: _scoreSuggestion(_getSuggestionText(suggestion)),
  }));

  const parent = items.map((_, idx) => idx);
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (_shouldMerge(items[i], items[j])) {
        _union(parent, i, j);
      }
    }
  }

  const clusters = new Map();
  for (let i = 0; i < items.length; i++) {
    const root = _find(parent, i);
    const list = clusters.get(root) || [];
    list.push(items[i]);
    clusters.set(root, list);
  }

  const representatives = [...clusters.values()]
    .map((cluster) => _pickRepresentative(cluster))
    .sort((a, b) => b.score - a.score);

  return representatives
    .slice(0, maxPerEntity)
    .map((item) => item.suggestion);
}

function _pickRepresentative(cluster) {
  return [...cluster].sort((a, b) => {
    const breadthDiff = _breadthScore(b.text) - _breadthScore(a.text);
    if (breadthDiff !== 0) return breadthDiff;
    const scoreDiff = b.score - a.score;
    if (scoreDiff !== 0) return scoreDiff;
    return b.text.length - a.text.length;
  })[0];
}

function _shouldMerge(a, b) {
  const sharedThemes = [...a.themes].filter((theme) => b.themes.has(theme));
  const overlap = _tokenOverlap(a.tokens, b.tokens);

  if (sharedThemes.length >= 1 && overlap.size >= 1) return true;
  if (overlap.size >= 3) return true;
  return false;
}

function _scoreSuggestion(text) {
  let score = 0;
  if (text.length >= 48) score += 1;
  if (IMPACT_PATTERNS.some((pattern) => pattern.test(text))) score += 3;
  if (BROADNESS_PATTERNS.some((pattern) => pattern.test(text))) score += 2;
  if (CODEY_PATTERNS.some((pattern) => pattern.test(text))) score -= 1;
  return score;
}

function _breadthScore(text) {
  let score = 0;
  if (BROADNESS_PATTERNS.some((pattern) => pattern.test(text))) score += 2;
  if (/[와과및]/.test(text)) score += 1;
  if (text.length >= 54) score += 1;
  if (CODEY_PATTERNS.some((pattern) => pattern.test(text))) score -= 1;
  return score;
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
  const matches = String(text || "").toLowerCase().match(/[a-z0-9.+/-]+|[가-힣]{2,}/g) || [];
  return new Set(matches.filter((token) => !_isWeakToken(token) && !STOPWORDS.has(token)));
}

function _isWeakToken(token) {
  if (!token) return true;
  if (/^\d+$/.test(token)) return true;
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

function _isCompressibleBulletSuggestion(suggestion) {
  return (
    suggestion?.source === "work_log" &&
    suggestion?.status === "pending" &&
    suggestion?.action === "append_bullet" &&
    (suggestion?.section === "experience" || suggestion?.section === "projects")
  );
}

function _getEntityId(suggestion) {
  return String(
    suggestion?.patch?.company ??
    suggestion?.patch?.projectName ??
    ""
  ).trim();
}

function _getSuggestionText(suggestion) {
  return String(
    suggestion?.patch?.bullet ??
    suggestion?.description ??
    ""
  ).trim();
}

function _find(parent, index) {
  if (parent[index] !== index) parent[index] = _find(parent, parent[index]);
  return parent[index];
}

function _union(parent, a, b) {
  const ra = _find(parent, a);
  const rb = _find(parent, b);
  if (ra !== rb) parent[rb] = ra;
}
