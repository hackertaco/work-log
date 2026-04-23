import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEvidenceBundles,
  filterSuggestionsWithLayeringRules,
  personSignalsFromBundles,
  projectExperienceCandidatesFromBundles,
} from "./resumeLayeredSignals.mjs";
import { summarizeProfile } from "./profile.mjs";

function makeProject(repo, commitCount, subjects, category = "company") {
  return {
    repo,
    category,
    commitCount,
    commits: subjects.map((subject, idx) => ({
      subject,
      hash: `${repo}-${idx}`,
    })),
  };
}

function makeDay({
  date,
  projects,
  storyThreads = [],
  aiReview = [],
  workingStyleSignals = [],
  commitAnalysis = [],
}) {
  return {
    date,
    projects,
    projectGroups: {
      company: projects.filter((project) => project.category === "company"),
      opensource: projects.filter((project) => project.category === "opensource"),
      other: projects.filter((project) => project.category === "other"),
    },
    highlights: {
      storyThreads,
      aiReview,
      workingStyleSignals,
      commitAnalysis,
    },
  };
}

test("buildEvidenceBundles marks small UX cleanup separately from impact-bearing project work", () => {
  const days = [
    makeDay({
      date: "2026-04-21",
      projects: [
        makeProject("product-web", 4, ["Fix checkout timeout", "Reduce payment retry noise"]),
        makeProject("design-system", 1, ["Tooltip spacing polish"]),
      ],
      storyThreads: [
        {
          repo: "product-web",
          outcome: "결제 흐름 실패율 감소",
          impact: "주요 기능 흐름의 오류 가능성을 줄임",
          why: "운영 비용을 줄일 수 있음",
        },
      ],
    }),
  ];

  const bundles = buildEvidenceBundles(days);
  const product = bundles.find((bundle) => bundle.repo === "product-web");
  const design = bundles.find((bundle) => bundle.repo === "design-system");

  assert.equal(product.impactSignal, true);
  assert.equal(product.isSmallUxCleanup, false);
  assert.equal(design.isSmallUxCleanup, true);
});

test("projectExperienceCandidatesFromBundles only promotes project-context + impact bundles", () => {
  const days = [
    makeDay({
      date: "2026-04-21",
      projects: [
        makeProject("product-web", 4, ["Fix checkout timeout", "Reduce payment retry noise"]),
        makeProject("design-system", 1, ["Tooltip spacing polish"]),
      ],
      storyThreads: [
        {
          repo: "product-web",
          outcome: "결제 흐름 실패율 감소",
          impact: "주요 기능 흐름의 오류 가능성을 줄임",
          why: "운영 비용을 줄일 수 있음",
        },
      ],
    }),
  ];

  const candidates = projectExperienceCandidatesFromBundles(buildEvidenceBundles(days));

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].repo, "product-web");
});

test("personSignalsFromBundles requires both score and repetition before surfacing", () => {
  const days = [
    makeDay({
      date: "2026-04-20",
      projects: [makeProject("product-web", 3, ["Fix checkout error", "Improve retry guard"])],
      storyThreads: [{ repo: "product-web", outcome: "안정성 강화", impact: "오류 가능성 감소" }],
    }),
    makeDay({
      date: "2026-04-21",
      projects: [makeProject("payments-api", 3, ["Fix payment crash", "Add guard for timeout"])],
      storyThreads: [{ repo: "payments-api", outcome: "운영 안정성 강화", impact: "운영 혼선 감소" }],
    }),
    makeDay({
      date: "2026-04-21",
      projects: [makeProject("design-system", 1, ["Tooltip spacing polish"])],
    }),
  ];

  const signals = personSignalsFromBundles(buildEvidenceBundles(days));
  const reliability = signals.find((signal) => signal.label === "Reliability engineering");
  const product = signals.find((signal) => signal.label === "Product judgment");

  assert.ok(reliability);
  assert.equal(reliability.surfaced, true);
  assert.ok(product ? product.surfaced === false || product.repetition < 2 : true);
});

test("summarizeProfile derives strengths from surfaced person signals and core projects from promoted experience candidates", () => {
  const days = [
    makeDay({
      date: "2026-04-20",
      projects: [makeProject("product-web", 4, ["Fix checkout error", "Reduce payment retry noise"])],
      storyThreads: [{ repo: "product-web", outcome: "결제 흐름 안정화", impact: "오류 가능성 감소", why: "운영 비용 절감" }],
      aiReview: ["운영 이슈를 안정화 관점에서 푸는 경향이 강하다."],
      workingStyleSignals: ["리스크를 먼저 좁히고 기능을 쌓는 패턴이 보인다."],
    }),
    makeDay({
      date: "2026-04-21",
      projects: [makeProject("product-web", 3, ["Fix checkout timeout", "Add retry guard"])],
      storyThreads: [{ repo: "product-web", outcome: "체크아웃 실패율 감소", impact: "사용자 이탈 감소", why: "전환 손실 방지" }],
      aiReview: ["예외 상황과 운영 리스크를 먼저 줄이는 편이다."],
      workingStyleSignals: ["개별 버그보다 흐름을 같이 보는 편이다."],
    }),
  ];

  const profile = summarizeProfile(days);

  assert.ok(profile.personSignals.length > 0);
  assert.ok(profile.strengths.some((item) => item.label === "Reliability engineering"));
  assert.ok(profile.coreProjects.some((project) => project.repo === "product-web"));
  assert.match(profile.resumeDraft.summary, /안정성|운영|흐름/);
});

test("filterSuggestionsWithLayeringRules drops experience suggestions for non-project small UX work", () => {
  const workLog = makeDay({
    date: "2026-04-21",
    projects: [makeProject("design-system", 1, ["Tooltip spacing polish"])],
    storyThreads: [],
  });

  const filtered = filterSuggestionsWithLayeringRules([
    { id: "exp-1", section: "experience", action: "append_bullet", description: "UX tidy" },
    { id: "sum-1", section: "summary", action: "update_summary", description: "summary" },
  ], workLog);

  assert.deepEqual(filtered.map((item) => item.id), ["sum-1"]);
});

test("filterSuggestionsWithLayeringRules keeps experience suggestions for project+impact work", () => {
  const workLog = makeDay({
    date: "2026-04-21",
    projects: [makeProject("product-web", 4, ["Fix checkout timeout", "Reduce payment retry noise"])],
    storyThreads: [{ repo: "product-web", outcome: "결제 흐름 안정화", impact: "오류 가능성 감소", why: "운영 비용 절감" }],
  });

  const filtered = filterSuggestionsWithLayeringRules([
    { id: "exp-1", section: "experience", action: "append_bullet", description: "checkout improvement" },
    { id: "proj-1", section: "projects", action: "append_bullet", description: "project improvement" },
  ], workLog);

  assert.equal(filtered.length, 2);
});

test("filterSuggestionsWithLayeringRules matches suggestions to relevant bundles instead of only day-level gate", () => {
  const workLog = makeDay({
    date: "2026-04-21",
    projects: [
      makeProject("product-web", 4, ["Fix checkout timeout", "Reduce payment retry noise"]),
      makeProject("design-system", 1, ["Tooltip spacing polish"]),
    ],
    storyThreads: [
      { repo: "product-web", outcome: "결제 흐름 안정화", impact: "오류 가능성 감소", why: "운영 비용 절감" },
    ],
  });

  const filtered = filterSuggestionsWithLayeringRules([
    {
      id: "exp-1",
      section: "experience",
      action: "append_bullet",
      description: "Acme Corp: Fix checkout timeout and reduce retry noise",
      patch: { company: "Acme Corp", bullet: "Fix checkout timeout and reduce retry noise" },
    },
    {
      id: "exp-2",
      section: "experience",
      action: "append_bullet",
      description: "Design system: Tooltip spacing polish",
      patch: { company: "Design system", bullet: "Tooltip spacing polish" },
    },
  ], workLog);

  assert.deepEqual(filtered.map((item) => item.id), ["exp-1"]);
});
