import fs from "node:fs/promises";
import path from "node:path";

import { fileExists, writeJson } from "./utils.mjs";

const STRENGTH_RULES = [
  {
    id: "reliability",
    label: "Reliability engineering",
    patterns: [/fix/i, /guard/i, /error/i, /crash/i, /resume/i, /retry/i, /stability/i, /안정/i, /예외/i]
  },
  {
    id: "product_judgment",
    label: "Product judgment",
    patterns: [/ux/i, /ui/i, /flow/i, /rollout/i, /리브랜딩/i, /운영/i, /가시성/i]
  },
  {
    id: "system_thinking",
    label: "System thinking",
    patterns: [/pipeline/i, /state/i, /causal/i, /architecture/i, /loop/i, /구조/i, /파이프라인/i]
  },
  {
    id: "debugging",
    label: "Debugging",
    patterns: [/debug/i, /trace/i, /diagn/i, /sentry/i, /qa/i, /gps/i, /cache/i]
  },
  {
    id: "tooling",
    label: "Developer tooling",
    patterns: [/install/i, /mcp/i, /hooks/i, /automation/i, /tool/i, /codex/i, /claude/i]
  }
];

const TECH_RULES = [
  { label: "React / Next.js", patterns: [/web/i, /getstaticprops/i, /router/i, /dialog/i, /lottie/i, /ui/i] },
  { label: "TypeScript", patterns: [/type/i, /types/i, /schema/i] },
  { label: "Maps / Location", patterns: [/gps/i, /map/i, /kakao/i, /route/i, /shuttle/i] },
  { label: "Payments / Operations", patterns: [/payment/i, /refund/i, /merchant/i, /deposit/i, /admission/i, /예약/i, /환불/i] },
  { label: "AI pipeline", patterns: [/causal/i, /deterministic/i, /scene/i, /plot/i, /validator/i, /llm/i] },
  { label: "Agent systems", patterns: [/mcp/i, /loop/i, /resume/i, /install/i, /agent/i, /ouroboros/i] }
];

export async function buildProfileSummary(config) {
  const dailyDir = path.join(config.dataDir, "daily");
  if (!(await fileExists(dailyDir))) {
    return emptyProfile();
  }

  const entries = (await fs.readdir(dailyDir))
    .filter((entry) => entry.endsWith(".json"))
    .sort();

  const days = [];
  for (const entry of entries) {
    const filePath = path.join(dailyDir, entry);
    try {
      days.push(JSON.parse(await fs.readFile(filePath, "utf8")));
    } catch {
      continue;
    }
  }

  const profile = summarizeProfile(days);
  const profilePath = path.join(config.dataDir, "profile", "summary.json");
  await writeJson(profilePath, profile);
  return { profile, profilePath };
}

export async function readProfileSummary(config) {
  const profilePath = path.join(config.dataDir, "profile", "summary.json");
  if (!(await fileExists(profilePath))) {
    return emptyProfile();
  }
  return JSON.parse(await fs.readFile(profilePath, "utf8"));
}

function summarizeProfile(days) {
  const repoMap = new Map();
  const strengthScores = new Map();
  const techScores = new Map();
  const aiReviewLines = [];

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
    aiReviewLines.push(...aiReview);

    scorePatterns(STRENGTH_RULES, [...subjects, ...aiReview], strengthScores);
    scorePatterns(TECH_RULES, subjects, techScores);
  }

  const strengths = rankMap(strengthScores).slice(0, 5);
  const techSignals = rankMap(techScores).slice(0, 6);
  const projectArcs = [...repoMap.values()]
    .sort((a, b) => b.totalCommits - a.totalCommits)
    .map((project) => ({
      repo: project.repo,
      category: project.category,
      totalCommits: project.totalCommits,
      activeDates: [...project.activeDates].sort(),
      summary: summarizeProjectArc(project)
    }))
    .slice(0, 8);

  const workStyle = inferWorkStyle(aiReviewLines, strengths);

  return {
    updatedAt: new Date().toISOString(),
    dayCount: days.length,
    strengths,
    techSignals,
    projectArcs,
    workStyle
  };
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

function inferWorkStyle(aiReviewLines, strengths) {
  const joined = aiReviewLines.join(" ");
  const style = [];

  if (joined || strengths.some((item) => item.label === "Reliability engineering")) {
    style.push("예외 상황과 운영 리스크를 먼저 줄이는 안정화 중심 성향.");
  }
  if (strengths.some((item) => item.label === "System thinking")) {
    style.push("개별 버그보다 흐름과 구조를 같이 보며 문제를 푸는 편.");
  }
  if (strengths.some((item) => item.label === "Product judgment")) {
    style.push("사용자 경험과 운영 가시성을 함께 고려해 제품 판단을 내리는 편.");
  }

  return style.slice(0, 3);
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
    strengths: [],
    techSignals: [],
    projectArcs: [],
    workStyle: []
  };
}
