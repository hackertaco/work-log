import fs from "node:fs/promises";
import path from "node:path";

import { fileExists, writeJson } from "./utils.mjs";
import {
  buildEvidenceBundles,
  personSignalsFromBundles,
  projectExperienceCandidatesFromBundles,
} from "./resumeLayeredSignals.mjs";

const TECH_RULES = [
  { label: "React / Next.js", patterns: [/web/i, /getstaticprops/i, /router/i, /dialog/i, /lottie/i, /ui/i] },
  { label: "TypeScript", patterns: [/type/i, /types/i, /schema/i] },
  { label: "Maps / Location", patterns: [/gps/i, /map/i, /kakao/i, /route/i, /shuttle/i] },
  { label: "Payments / Operations", patterns: [/payment/i, /refund/i, /merchant/i, /deposit/i, /admission/i, /예약/i, /환불/i] },
  { label: "AI pipeline", patterns: [/causal/i, /deterministic/i, /scene/i, /plot/i, /validator/i, /llm/i] },
  { label: "Agent systems", patterns: [/mcp/i, /loop/i, /resume/i, /install/i, /agent/i, /ouroboros/i] }
];

export async function buildProfileSummary(config) {
  const days = await readDailySummaries(config);
  const profile = summarizeProfile(days);
  const profilePath = path.join(config.dataDir, "profile", "summary.json");
  await writeJson(profilePath, profile);
  return { profile, profilePath };
}

export async function readProfileSummary(config, options = {}) {
  const windowDays = normalizeWindowDays(options.windowDays);
  if (windowDays) {
    const days = await readDailySummaries(config, { windowDays });
    return summarizeProfile(days, { windowDays });
  }

  const profilePath = path.join(config.dataDir, "profile", "summary.json");
  if (!(await fileExists(profilePath))) {
    return emptyProfile();
  }
  return JSON.parse(await fs.readFile(profilePath, "utf8"));
}

export function summarizeProfile(days, options = {}) {
  const windowDays = normalizeWindowDays(options.windowDays);
  const repoMap = new Map();
  const techScores = new Map();
  const aiReviewLines = [];
  const workingStyleLines = [];
  const evidenceBundles = buildEvidenceBundles(days);
  const projectCandidates = projectExperienceCandidatesFromBundles(evidenceBundles);
  const personSignals = personSignalsFromBundles(evidenceBundles);
  const surfacedPersonSignals = personSignals.filter((item) => item.surfaced);

  for (const day of days) {
    const groups = day.projectGroups || {};
    const allProjects = [...(groups.company || []), ...(groups.opensource || []), ...(groups.other || [])];

    for (const project of allProjects) {
      const existing = repoMap.get(project.repo) || {
        repo: project.repo,
        category: project.category || "other",
        totalCommits: 0,
        activeDates: new Set(),
        subjects: []
      };

      existing.totalCommits += project.commitCount || 0;
      existing.activeDates.add(day.date);
      existing.subjects.push(...(project.commits || []).map((commit) => commit.subject).filter(Boolean));
      repoMap.set(project.repo, existing);
    }

    const subjects = (day.projects || []).flatMap((project) => (project.commits || []).map((commit) => commit.subject));
    const aiReview = day.highlights?.aiReview || [];
    const workingStyleSignals = day.highlights?.workingStyleSignals || [];
    aiReviewLines.push(...aiReview);
    workingStyleLines.push(...workingStyleSignals);

    scorePatterns(TECH_RULES, subjects, techScores);
  }

  const strengths = surfacedPersonSignals
    .slice(0, 5)
    .map((item) => ({ label: item.label, score: item.score, confidence: item.confidence }));
  const techSignals = rankMap(techScores).slice(0, 6);
  const projectArcs = mergeProjectArcs(projectCandidates, repoMap)
    .slice(0, 8);

  const workStyle = inferWorkStyleFromSignals(surfacedPersonSignals, [...aiReviewLines, ...workingStyleLines]);
  const narrativeAxes = deriveNarrativeAxes(strengths, projectArcs);
  const identitySignals = deriveIdentitySignals({
    personSignals: surfacedPersonSignals,
    workStyle,
  });
  const resumeDraft = deriveResumeDraft({
    strengths,
    workStyle,
    narrativeAxes,
    coreProjects: projectArcs.slice(0, 4)
  });
  const coreProjects = projectArcs.slice(0, 4).map((project) => ({
    repo: project.repo,
    summary: project.summary
  }));

  return {
    updatedAt: new Date().toISOString(),
    dayCount: days.length,
    windowDays: windowDays ?? null,
    strengths,
    personSignals,
    techSignals,
    projectArcs,
    workStyle,
    identitySignals,
    narrativeAxes,
    resumeDraft,
    coreProjects
  };
}

async function readDailySummaries(config, options = {}) {
  const windowDays = normalizeWindowDays(options.windowDays);
  const dailyDir = path.join(config.dataDir, "daily");
  if (!(await fileExists(dailyDir))) return [];

  let entries = (await fs.readdir(dailyDir))
    .filter((entry) => entry.endsWith(".json"))
    .sort()
    .reverse();

  if (windowDays) {
    entries = entries.slice(0, windowDays);
  }

  const days = [];
  for (const entry of entries.reverse()) {
    const filePath = path.join(dailyDir, entry);
    try {
      days.push(JSON.parse(await fs.readFile(filePath, "utf8")));
    } catch {
      continue;
    }
  }

  return days;
}

function summarizeProjectArc(project) {
  const joined = project.subjects.join(" ");
  if (project.repo === "driving-teacher-frontend") {
    return "운영성, 예약/체크인, 셔틀/GPS, UI 안정화 작업이 반복적으로 누적된 핵심 실무 프로젝트.";
  }
  if (project.repo === "kakao-novel-generator") {
    return "서사 생성 품질을 높이기 위한 검증·제어 로직을 지속적으로 고도화한 프로젝트.";
  }
  if (project.repo === "ouroboros") {
    return "에이전트 실행 루프, 설치 경로, 재개 흐름을 장기적으로 다듬는 도구 인프라 프로젝트.";
  }
  if (project.repo === "ouroboros-family") {
    return "PR 리뷰 자동화와 git safety 규칙을 개선하는 협업 도구 프로젝트.";
  }
  if (/map|gps|shuttle|route/i.test(joined)) {
    return "지도·위치·이동 흐름과 관련된 안정화 작업이 누적된 프로젝트.";
  }
  return "반복적인 개선이 누적되며 역할과 방향성이 드러나는 장기 프로젝트.";
}

function inferWorkStyleFromSignals(personSignals, aiReviewLines) {
  const joined = aiReviewLines.join(" ");
  const style = [];
  const labels = new Set((personSignals || []).map((item) => item.label));

  if (joined || labels.has("Reliability engineering")) {
    style.push("예외 상황과 운영 리스크를 먼저 줄이는 안정화 중심 성향.");
  }
  if (labels.has("System thinking")) {
    style.push("개별 버그보다 흐름과 구조를 같이 보며 문제를 푸는 편.");
  }
  if (labels.has("Product judgment")) {
    style.push("사용자 경험과 운영 가시성을 함께 고려해 제품 판단을 내리는 편.");
  }
  if (labels.has("Debugging") || /(기대치와 실제 결과의 간극|잡음을 줄여 판단 비용|전체 흐름과 구조|완성도 기준|리스크를 먼저)/.test(joined)) {
    style.push("대화와 정리 과정을 통해 기준을 명확히 하고 팀의 판단 비용을 낮추는 편.");
  }

  return style.slice(0, 3);
}

function deriveNarrativeAxes(strengths, projectArcs) {
  const labels = new Set((strengths || []).map((item) => item.label));
  const axes = [];

  if (labels.has("Reliability engineering") || labels.has("Debugging")) {
    axes.push("운영 복잡도를 안정된 흐름으로 바꾸는 엔지니어");
  }
  if (labels.has("Product judgment") || labels.has("System thinking")) {
    axes.push("복잡한 작업 흐름을 제품 경험으로 정리하는 엔지니어");
  }
  if (labels.has("Developer tooling") || projectArcs.some((project) => /agent|tool|workflow|loop/i.test(project.repo))) {
    axes.push("반복 작업을 도구와 시스템으로 구조화하는 엔지니어");
  }

  if (axes.length === 0 && projectArcs.length > 0) {
    axes.push("반복적으로 개선이 누적되는 프로젝트를 끝까지 구조화하는 엔지니어");
  }

  return axes.slice(0, 3);
}

function deriveIdentitySignals({ personSignals, workStyle }) {
  const labels = new Set((personSignals || []).map((item) => item.label));
  const signals = [];

  if (labels.has("Product judgment")) {
    signals.push({
      id: "expectation-alignment",
      label: "Expectation Alignment",
      description: "기대치와 실제 진행 흐름의 어긋남을 먼저 줄이려는 성향.",
      confidence: 0.82,
    });
  }
  if (labels.has("Reliability engineering") || labels.has("Debugging")) {
    signals.push({
      id: "noise-reduction",
      label: "Noise Reduction",
      description: "잡음을 줄여 판단 비용과 운영 피로를 낮추려는 성향.",
      confidence: 0.84,
    });
  }
  if (labels.has("System thinking")) {
    signals.push({
      id: "systems-framing",
      label: "Systems Framing",
      description: "개별 수정이 아니라 전체 흐름과 구조를 함께 보며 문제를 푸는 성향.",
      confidence: 0.85,
    });
  }
  if (workStyle.some((item) => /기준을 명확히/.test(item))) {
    signals.push({
      id: "quality-bar",
      label: "Quality Bar Raising",
      description: "말과 기준을 먼저 정리하고 결과물의 완성도와 일관성을 끌어올리는 성향.",
      confidence: 0.73,
    });
  }

  return signals.slice(0, 4);
}

function deriveResumeDraft({ strengths, workStyle, narrativeAxes, coreProjects }) {
  const topStrength = strengths?.[0]?.label || null;
  const secondStrength = strengths?.[1]?.label || null;
  const topAxis = narrativeAxes?.[0] || null;
  const topStyle = workStyle?.[0] || null;
  const topProject = coreProjects?.[0]?.summary || null;

  const headline = topAxis || (
    topStrength
      ? `${translateStrengthLabel(topStrength)}이 반복되는 엔지니어`
      : "누적 기록에서 서서히 드러나는 엔지니어"
  );

  const summaryParts = [];
  if (topAxis) {
    summaryParts.push(`${topAxis}라는 방향성이 가장 선명합니다.`);
  }
  if (topStrength) {
    const pair = secondStrength ? `, ${translateStrengthLabel(secondStrength)}` : "";
    summaryParts.push(`${translateStrengthLabel(topStrength)}${pair}이 강하게 반복됩니다.`);
  }
  if (topStyle) {
    summaryParts.push(topStyle);
  }
  if (topProject) {
    summaryParts.push(`대표적으로는 ${topProject}`);
  }

  return {
    headline,
    summary: summaryParts.join(" ").trim(),
    strengthLabels: strengths.slice(0, 3).map((item) => translateStrengthLabel(item.label))
  };
}

function translateStrengthLabel(label) {
  const map = {
    "Reliability engineering": "안정성·운영 신뢰",
    "Product judgment": "제품 판단력",
    "System thinking": "구조적 사고",
    "Debugging": "문제 추적·진단",
    "Developer tooling": "개발 도구화"
  };
  return map[label] || label;
}

function mergeProjectArcs(projectCandidates, repoMap) {
  const candidates = Array.isArray(projectCandidates) ? projectCandidates : [];
  const candidateRepos = new Set(candidates.map((item) => item.repo));
  const fallbackArcs = [...repoMap.values()]
    .filter((project) => !candidateRepos.has(project.repo))
    .sort((a, b) => b.totalCommits - a.totalCommits)
    .map((project) => ({
      repo: project.repo,
      category: project.category,
      totalCommits: project.totalCommits,
      activeDates: [...project.activeDates].sort(),
      summary: summarizeProjectArc(project),
    }));

  return [
    ...candidates.map((project) => ({
      repo: project.repo,
      category: project.category,
      totalCommits: project.totalCommits,
      activeDates: project.activeDates,
      summary: project.summary,
    })),
    ...fallbackArcs,
  ];
}

function scorePatterns(rules, texts, store) {
  for (const text of texts) {
    const normalized = String(text || "");
    for (const rule of rules) {
      if (rule.patterns.some((pattern) => pattern.test(normalized))) {
        store.set(rule.label, (store.get(rule.label) || 0) + 1);
      }
    }
  }
}

function rankMap(map) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, score]) => ({ label, score }));
}

function emptyProfile() {
  return {
    updatedAt: null,
    dayCount: 0,
    windowDays: null,
    strengths: [],
    techSignals: [],
    projectArcs: [],
    workStyle: [],
    identitySignals: [],
    narrativeAxes: [],
    resumeDraft: {
      headline: "",
      summary: "",
      strengthLabels: []
    },
    coreProjects: []
  };
}

function normalizeWindowDays(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.trunc(number);
}
