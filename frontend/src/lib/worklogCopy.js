const REPOISH_PREFIX = /^[a-z0-9]+(?:[-_/][a-z0-9]+){2,}(?:-[A-Z]+-[a-z0-9-]+)?\s+관련 작업의\s*/i;
const REPOISH_TOKEN = /\b[a-z0-9]+(?:[-_/][a-z0-9]+){2,}(?:-[A-Z]+-[a-z0-9-]+)?\b/g;

const BOILERPLATE_REWRITES = [
  [/운영 안정성과 개발 생산성을 개선했다/g, '흐름을 더 안정적으로 정리했다'],
  [/주요 기능 흐름의 오류 가능성을 줄임/g, '주요 흐름의 오류 가능성을 줄였다'],
  [/오류 가능성을 줄임/g, '오류 가능성을 줄였다'],
  [/학습자 기대치와 실제 진행 흐름이 더 잘 맞도록 조정함/g, '안내 흐름을 실제 사용 맥락에 맞게 다듬었다'],
  [/사용자 기대와 실제 진행 과정의 불일치를 줄임/g, '사용자 기대와 실제 흐름의 어긋남을 줄였다'],
];

export function sanitizeWorklogCopy(text, { maxLength = 0 } = {}) {
  let value = String(text || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return '';

  value = value
    .replace(/^.*?에서\s+\d+개의\s+커밋을\s+통해\s+/i, '')
    .replace(/\s*관련 작업을 진행했다\.?$/i, '')
    .replace(REPOISH_PREFIX, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*→\s*/g, ' → ')
    .replace(/^(feat|fix|refactor|chore|docs|test|perf)\s*:\s*/i, '')
    .replace(/:\s*$/,'')
    .trim();

  for (const [pattern, replacement] of BOILERPLATE_REWRITES) {
    value = value.replace(pattern, replacement);
  }

  if (/^[a-z0-9]+(?:[-_/][a-z0-9]+){2,}(?:-[A-Z]+-[a-z0-9-]+)?$/i.test(value)) {
    value = '관련 흐름을 정리했다';
  }

  value = value.replace(/\b([a-z0-9]+(?:[-_/][a-z0-9]+){3,})\b/gi, (match) => {
    if (match.length > 32) return '관련 흐름';
    return match;
  });

  value = value
    .replace(/^관련 흐름\s+관련 작업의\s*/i, '')
    .replace(/\.\s*\.*/g, '.')
    .replace(/\s+([,.!?])/g, '$1')
    .trim();

  if (maxLength && value.length > maxLength) {
    value = `${value.slice(0, maxLength - 1).trim()}…`;
  }

  return value;
}


export function sanitizeWorklogList(items, { maxItems = 4, maxLength = 110 } = {}) {
  return (Array.isArray(items) ? items : [])
    .map((item) => sanitizeWorklogCopy(item, { maxLength }))
    .filter(Boolean)
    .filter((item, index, arr) => arr.indexOf(item) === index)
    .slice(0, maxItems);
}

export function splitCompactStoryHighlights(value) {
  if (typeof value !== 'string') return [];

  const normalized = value
    .replace(/\s+/g, ' ')
    .replace(/\s+—\s+/g, ' — ')
    .replace(/\s*→\s*/g, ' → ')
    .replace(/\s+(?=(feat|fix|refactor|chore|docs|test|perf)\()/gi, '\n')
    .replace(/\s+(?=(feat:|fix:|refactor:|chore:|docs:|test:|perf:))/gi, '\n')
    .replace(/\s*\|\s*/g, '\n')
    .replace(/\s*;\s*/g, '\n')
    .trim();

  const parts = normalized
    .split(/\n+/)
    .map((part) => sanitizeWorklogCopy(part).trim().replace(/^[-•]+\s*/, ''))
    .filter(Boolean)
    .map((part) => summarizeStoryFragment(part));

  return Array.from(new Set(parts)).filter(Boolean);
}

export function deriveStoryTitle({ outcome = '', impact = '', why = '', keyChange = '', repo = '' }) {
  const candidates = [
    normalizeStoryTitle(summarizeStoryFragment(keyChange), { repo, maxLength: 56 }),
    normalizeStoryTitle(impact, { repo, maxLength: 56 }),
    normalizeStoryTitle(outcome, { repo, maxLength: 56 }),
    normalizeStoryTitle(why, { repo, maxLength: 56 }),
  ].filter(Boolean);

  return candidates.sort((left, right) => scoreStoryTitle(right) - scoreStoryTitle(left))[0] || '핵심 변화를 정리함';
}

export function buildWorklogShareSentence({ outcomes = [], whyItMatters = [], changes = [] }) {
  const outcome = pickStrongestText(outcomes);
  const why = pickStrongestText(whyItMatters, [outcome]);
  const change = pickStrongestText(changes, [outcome, why]);

  const outcomeLine = normalizeSentence(sanitizeWorklogCopy(outcome, { maxLength: 120 }));
  const whyLine = normalizeSentence(sanitizeWorklogCopy(why, { maxLength: 110 }));
  const changeLine = normalizeSentence(sanitizeWorklogCopy(change, { maxLength: 110 }));

  if (changeLine && whyLine) {
    return `${toSentenceBody(changeLine)}. 그래서 ${toSentenceBody(whyLine)}.`;
  }
  if (changeLine && outcomeLine) {
    return `${toSentenceBody(changeLine)}. 그 결과 ${toSentenceBody(outcomeLine)}.`;
  }
  if (outcomeLine && whyLine) {
    return `${toSentenceBody(outcomeLine)}. 그래서 ${toSentenceBody(whyLine)}.`;
  }
  return changeLine || outcomeLine || whyLine || '';
}

function normalizeStoryTitle(text, { repo = '', maxLength = 0 } = {}) {
  let value = sanitizeWorklogCopy(text, { maxLength: 0 });
  if (!value) return '';

  if (repo) {
    const escaped = repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    value = value.replace(new RegExp(`^${escaped}에서\s*`, 'i'), '');
  }

  value = value
    .replace(/에서 진행한 핵심 흐름을 정리하고 개선함$/g, '')
    .replace(/에서 진행한 .* 작업$/g, '')
    .replace(/^관련 흐름을 /, '')
    .replace(/^핵심 흐름을 /, '')
    .replace(/^(운영과 개발 모두에서|운영과 개발에서)\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!value || /^관련 흐름/.test(value)) return '';

  if (/진행한 핵심 흐름을 정리하고 개선함|핵심 흐름을 정리하고 개선함|관련 작업을 진행했다/.test(value)) return '';
  if (/^(개선함|개선했다|정리했다|다듬었다|줄였다|높였다)$/.test(value)) return '';

  if (maxLength && value.length > maxLength) {
    value = `${value.slice(0, maxLength - 1).trim()}…`;
  }

  return value;
}

function scoreStoryTitle(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return -999;

  let score = 0;
  if (!REPOISH_TOKEN.test(normalized)) score += 6;
  if (normalized.length >= 10 && normalized.length <= 34) score += 5;
  if (/(줄이|낮추|정리|방지|보완|안정|간소화|개선|재정비|고정|추출|분리|통합|단순화)/.test(normalized)) score += 4;
  if (/(흐름|구조|운영|예약|결제|지도|상담|학습|리뷰|템플릿|중복|발송|타임아웃|가드|정산|QA)/.test(normalized)) score += 3;
  if (/에서 진행한|관련 작업/.test(normalized)) score -= 8;
  if (normalized.length > 46) score -= 4;
  return score;
}

function summarizeStoryFragment(text) {
  if (!text) return '';
  const trimmed = sanitizeWorklogCopy(text);
  if (trimmed.length <= 88) return trimmed;

  const dashIndex = trimmed.indexOf(' — ');
  if (dashIndex > 0 && dashIndex < 72) {
    return trimmed.slice(0, dashIndex + 2).trim();
  }

  const colonIndex = trimmed.indexOf(': ');
  if (colonIndex > 0 && colonIndex < 48) {
    return trimmed.slice(0, colonIndex + 1) + ' ' + trimmed.slice(colonIndex + 2).split(/,|\.|→/)[0].trim();
  }

  return `${trimmed.slice(0, 84).trim()}…`;
}

function normalizeSentence(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  return `${trimmed.replace(/[.!?]\s*$/, '')}.`;
}

function toSentenceBody(text) {
  return String(text || '').trim().replace(/[.!?]\s*$/, '');
}

function pickStrongestText(items, exclude = []) {
  const excluded = new Set(exclude.map((item) => String(item || '').trim()).filter(Boolean));
  return rankImpactTexts(items).find((item) => !excluded.has(String(item || '').trim())) || '';
}

export function rankImpactTexts(items) {
  return [...new Set((Array.isArray(items) ? items : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean))]
    .sort((left, right) => scoreImpactText(right) - scoreImpactText(left));
}

function scoreImpactText(text) {
  const normalized = String(text || '').toLowerCase();
  let score = 0;

  if (/(줄였|감소|방지|막았|개선|높였|증가|복구|안정|정확|누락|오류|리스크|전환|성능|속도|impact|reduce|improve|prevent|increase|stability|error|risk)/.test(normalized)) {
    score += 5;
  }
  if (/(고객|운영|결제|예약|체크인|환불|merchant|payment|refund|admission|cs)/.test(normalized)) {
    score += 3;
  }
  if (/\d|%/.test(normalized)) {
    score += 2;
  }

  score += Math.min(normalized.length / 24, 4);

  if (normalized.length < 14) score -= 2;
  if (normalized.length > 120) score -= 1;

  return score;
}

export const __private__ = {
  summarizeStoryFragment,
  normalizeSentence,
  toSentenceBody,
  pickStrongestText,
  rankImpactTexts,
  scoreImpactText,
  REPOISH_TOKEN,
  normalizeStoryTitle,
  scoreStoryTitle,
};
