const PERSON_SIGNAL_RULES = [
  {
    id: "reliability",
    label: "Reliability engineering",
    description: "오류를 줄이고 예외 상황을 먼저 정리하는 경향",
    patterns: [/fix/i, /guard/i, /error/i, /crash/i, /retry/i, /stability/i, /안정/i, /예외/i, /sentry/i],
  },
  {
    id: "product_judgment",
    label: "Product judgment",
    description: "사용자 기대와 실제 흐름의 어긋남을 줄이려는 경향",
    patterns: [/ux/i, /ui/i, /flow/i, /rollout/i, /운영/i, /가시성/i, /기대치/i, /정렬/i],
  },
  {
    id: "system_thinking",
    label: "System thinking",
    description: "개별 수정이 아니라 구조와 상태 흐름을 함께 다루는 경향",
    patterns: [/pipeline/i, /state/i, /architecture/i, /loop/i, /구조/i, /파이프라인/i, /workflow/i],
  },
  {
    id: "debugging",
    label: "Debugging",
    description: "원인 파악과 관측 가능성 확보를 중시하는 경향",
    patterns: [/debug/i, /trace/i, /diagn/i, /qa/i, /gps/i, /cache/i, /regression/i, /noise/i],
  },
  {
    id: "tooling",
    label: "Developer tooling",
    description: "반복 작업을 도구와 시스템으로 구조화하는 경향",
    patterns: [/install/i, /mcp/i, /hooks/i, /automation/i, /tool/i, /codex/i, /claude/i, /workflow/i],
  },
];

const IMPACT_PATTERNS = [
  /impact/i,
  /reduce/i,
  /improv/i,
  /prevent/i,
  /increase/i,
  /stability/i,
  /error/i,
  /risk/i,
  /운영/i,
  /혼선/i,
  /이탈/i,
  /오작동/i,
  /누락/i,
  /안정/i,
  /비용/i,
  /신뢰도/i,
  /\d/,
  /%/,
];

const SMALL_UX_PATTERNS = [
  /tooltip/i,
  /spacing/i,
  /copy/i,
  /label/i,
  /portal/i,
  /잘림/,
  /문구/,
  /정렬/,
  /상태 정리/,
  /noise/i,
];

const EXPERIENCE_MIN_IMPACT_SCORE = 2;
const PERSON_SIGNAL_MIN_SCORE = 3;
const PERSON_SIGNAL_MIN_REPETITION = 2;

/**
 * Build shared evidence bundles from daily worklog summaries.
 *
 * @param {object[]} days
 * @returns {object[]}
 */
export function buildEvidenceBundles(days) {
  const bundles = [];

  for (const day of Array.isArray(days) ? days : []) {
    const projects = Array.isArray(day?.projects) ? day.projects : [];
    const storyThreads = Array.isArray(day?.highlights?.storyThreads)
      ? day.highlights.storyThreads
      : [];
    const commitAnalysis = Array.isArray(day?.highlights?.commitAnalysis)
      ? day.highlights.commitAnalysis
      : [];

    for (const project of projects) {
      const repo = project?.repo;
      if (!repo) continue;

      const subjects = (Array.isArray(project.commits) ? project.commits : [])
        .map((commit) => String(commit?.subject ?? "").trim())
        .filter(Boolean);
      const story = storyThreads.find((thread) => thread?.repo === repo) ?? null;
      const repoAnalysis = commitAnalysis.filter((line) =>
        String(line || "").toLowerCase().includes(String(repo).toLowerCase())
      );

      const textParts = [
        ...subjects,
        story?.outcome,
        story?.keyChange,
        story?.impact,
        story?.why,
        story?.decision,
        ...repoAnalysis,
      ].filter(Boolean);

      const joined = textParts.join(" ");
      const impactScore = scoreByPatterns(textParts, IMPACT_PATTERNS) + (story?.impact ? 1 : 0);
      const smallUxScore = scoreByPatterns(textParts, SMALL_UX_PATTERNS);
      const signalMatches = PERSON_SIGNAL_RULES
        .map((rule) => ({
          id: rule.id,
          label: rule.label,
          description: rule.description,
          score: scoreByPatterns(textParts, rule.patterns),
        }))
        .filter((rule) => rule.score > 0);

      bundles.push({
        id: `${day.date}:${repo}`,
        date: day.date,
        repo,
        category: project.category || "other",
        commitCount: Number(project.commitCount || 0),
        subjects,
        story,
        repoAnalysis,
        joinedText: joined,
        projectContext: Boolean(repo && subjects.length > 0),
        impactScore,
        impactSignal: impactScore >= EXPERIENCE_MIN_IMPACT_SCORE,
        isSmallUxCleanup:
          smallUxScore > 0 &&
          impactScore < EXPERIENCE_MIN_IMPACT_SCORE + 1 &&
          subjects.length <= 4,
        signalMatches,
      });
    }
  }

  return bundles;
}

/**
 * Aggregate project-scale experience candidates from shared evidence bundles.
 *
 * @param {object[]} bundles
 * @returns {object[]}
 */
export function projectExperienceCandidatesFromBundles(bundles) {
  const grouped = new Map();

  for (const bundle of Array.isArray(bundles) ? bundles : []) {
    if (!bundle.projectContext || !bundle.impactSignal || bundle.isSmallUxCleanup) {
      continue;
    }

    const existing = grouped.get(bundle.repo) || {
      repo: bundle.repo,
      category: bundle.category || "other",
      totalCommits: 0,
      activeDates: new Set(),
      subjects: [],
      impactSnippets: [],
      bundles: [],
    };

    existing.totalCommits += Number(bundle.commitCount || 0);
    existing.activeDates.add(bundle.date);
    existing.subjects.push(...bundle.subjects);
    if (bundle.story?.impact) existing.impactSnippets.push(bundle.story.impact);
    if (bundle.story?.why) existing.impactSnippets.push(bundle.story.why);
    existing.bundles.push(bundle);
    grouped.set(bundle.repo, existing);
  }

  return [...grouped.values()]
    .sort((left, right) => right.totalCommits - left.totalCommits)
    .map((candidate) => ({
      repo: candidate.repo,
      category: candidate.category,
      totalCommits: candidate.totalCommits,
      activeDates: [...candidate.activeDates].sort(),
      summary: summarizeExperienceCandidate(candidate),
      bundles: candidate.bundles,
    }));
}

/**
 * Build scored person/strength signals from shared evidence bundles.
 *
 * @param {object[]} bundles
 * @returns {object[]}
 */
export function personSignalsFromBundles(bundles) {
  const aggregates = new Map();

  for (const bundle of Array.isArray(bundles) ? bundles : []) {
    for (const match of bundle.signalMatches || []) {
      const existing = aggregates.get(match.id) || {
        id: match.id,
        label: match.label,
        description: match.description,
        score: 0,
        dates: new Set(),
        repos: new Set(),
        evidence: [],
      };

      existing.score += match.score + (bundle.impactSignal ? 1 : 0);
      existing.dates.add(bundle.date);
      existing.repos.add(bundle.repo);
      if (bundle.story?.outcome) existing.evidence.push(bundle.story.outcome);
      else if (bundle.subjects[0]) existing.evidence.push(bundle.subjects[0]);

      aggregates.set(match.id, existing);
    }
  }

  return [...aggregates.values()]
    .map((item) => {
      const repetition = Math.max(item.dates.size, item.repos.size);
      const surfaced =
        item.score >= PERSON_SIGNAL_MIN_SCORE &&
        repetition >= PERSON_SIGNAL_MIN_REPETITION;

      return {
        id: item.id,
        label: item.label,
        description: item.description,
        score: item.score,
        repetition,
        surfaced,
        confidence: Number(Math.min(0.95, 0.3 + ((item.score + repetition) / 12)).toFixed(2)),
        evidenceExamples: [...new Set(item.evidence)].slice(0, 3),
      };
    })
    .sort((left, right) => right.score - left.score);
}

/**
 * Apply the layered experience/project gate to generated suggestions.
 *
 * This is a day-level gate: if a work-log day does not contain at least one
 * project-scale + impact-bearing evidence bundle, experience/project
 * suggestions from that day are treated as too weak and filtered out.
 *
 * @param {object[]} suggestions
 * @param {object|null|undefined} workLog
 * @returns {object[]}
 */
export function filterSuggestionsWithLayeringRules(suggestions, workLog) {
  const list = Array.isArray(suggestions) ? suggestions : [];
  const bundles = buildEvidenceBundles(workLog ? [workLog] : []);
  const promotedProjectCandidates = projectExperienceCandidatesFromBundles(bundles);
  const hasExperienceGradeSignal = promotedProjectCandidates.length > 0;

  return list.filter((suggestion) => {
    const section = suggestion?.section;
    if (section !== "experience" && section !== "projects") {
      return true;
    }

    const relevantBundles = bundles.filter((bundle) =>
      matchesSuggestionToBundle(suggestion, bundle)
    );

    if (relevantBundles.length === 0) {
      return hasExperienceGradeSignal;
    }

    return relevantBundles.some(
      (bundle) => bundle.projectContext && bundle.impactSignal && !bundle.isSmallUxCleanup
    );
  });
}

function summarizeExperienceCandidate(candidate) {
  const impact = candidate.impactSnippets.find(Boolean);
  if (impact) {
    return impact;
  }

  const topSubject = candidate.subjects.find(Boolean);
  if (topSubject) {
    return `${candidate.repo}에서 ${topSubject.toLowerCase()} 중심의 개선을 진행한 프로젝트.`;
  }

  return `${candidate.repo}에서 프로젝트 단위 결과로 설명 가능한 개선이 누적된 작업.`;
}

function scoreByPatterns(texts, patterns) {
  const joined = Array.isArray(texts) ? texts.join(" ") : String(texts || "");
  return patterns.reduce((score, pattern) => score + (pattern.test(joined) ? 1 : 0), 0);
}

function matchesSuggestionToBundle(suggestion, bundle) {
  const suggestionTokens = tokenizeSuggestionText(suggestion);
  const bundleTokens = tokenizeText([
    bundle.repo,
    ...(bundle.subjects || []),
    bundle.story?.outcome,
    bundle.story?.keyChange,
    bundle.story?.impact,
    bundle.story?.why,
    ...(bundle.repoAnalysis || []),
  ].filter(Boolean).join(" "));

  if (suggestionTokens.length === 0 || bundleTokens.length === 0) return false;

  let overlap = 0;
  for (const token of suggestionTokens) {
    if (bundleTokens.includes(token)) overlap += 1;
  }
  return overlap >= Math.min(2, suggestionTokens.length);
}

function tokenizeSuggestionText(suggestion) {
  const parts = [
    suggestion?.description,
    suggestion?.detail,
    suggestion?.patch?.bullet,
    suggestion?.patch?.newBullet,
    suggestion?.patch?.oldBullet,
    suggestion?.patch?.text,
    suggestion?.patch?.projectName,
    suggestion?.patch?.company,
    suggestion?.patch?.entry?.company,
    suggestion?.patch?.entry?.title,
  ].filter(Boolean);

  return tokenizeText(parts.join(" "));
}

function tokenizeText(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9가-힣]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}
