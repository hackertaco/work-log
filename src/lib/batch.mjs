import path from "node:path";

import { readBulletCache, writeBulletCache } from "./bulletCache.mjs";
import { loadConfig } from "./config.mjs";
import { summarizeWithOpenAI } from "./openai.mjs";
import { buildProfileSummary } from "./profile.mjs";
import {
  emitCommitCollected,
  emitSessionCollected,
  emitSlackCollected,
  emitWorkLogSaved
} from "./workLogEventBus.mjs";
import {
  detectPrBranchMentions,
  sortProjectsByPrWeight
} from "./resumePrBranchParser.mjs";
import { collectSlackContexts } from "./slack.mjs";
import {
  collectClaudeSessions,
  collectCodexSessions,
  collectGitCommits,
  collectShellHistory
} from "./sources.mjs";
import {
  ensureDir,
  looksLikeQuestion,
  parseDateArg,
  uniqueStrings,
  writeJson,
  writeText
} from "./utils.mjs";

export async function runDailyBatch(inputDate) {
  const date = parseDateArg(inputDate);
  const config = await loadConfig();

  await Promise.all([
    ensureDir(config.vaultDir),
    ensureDir(config.dataDir)
  ]);

  const [codexSessions, claudeSessions, slackContexts, gitData, shellHistory] = await Promise.all([
    config.includeSessionLogs ? collectCodexSessions(config, date) : Promise.resolve([]),
    config.includeSessionLogs ? collectClaudeSessions(config, date) : Promise.resolve([]),
    config.includeSlack ? collectSlackContexts(date) : Promise.resolve([]),
    collectGitCommits(config, date),
    collectShellHistory(config, date)
  ]);

  // ── Granular event emissions (Sub-AC 2-1) ─────────────────────────────────
  //
  // Emit informational events for each collected data source immediately after
  // the parallel collection resolves.  Listeners registered via onWorkLogEvent()
  // can use these for logging, monitoring, or incremental processing without
  // waiting for the full summary to be built.
  //
  // These are fire-and-forget: the batch pipeline does not await them.
  emitCommitCollected(date, gitData.commits);
  if (config.includeSlack) emitSlackCollected(date, slackContexts);
  if (config.includeSessionLogs) {
    emitSessionCollected(date, [...codexSessions, ...claudeSessions]);
  }

  // ── PR/branch signal detection (Sub-AC 11b) ────────────────────────────────
  //
  // Scan all collected data for PR and branch mentions before building the
  // summary.  The resulting projectWeights map is threaded through to
  // buildSummary() and ultimately to the LLM extraction prompt so that
  // projects with active PR/branch activity are surfaced first.
  const prBranchSignals = detectPrBranchMentions({
    gitCommits: gitData.commits,
    shellHistory,
    codexSessions,
    claudeSessions
  });

  if (Object.keys(prBranchSignals.projectWeights).length > 0) {
    console.info(
      `[batch date="${date}"] PR/branch signals detected for: ` +
        Object.entries(prBranchSignals.projectWeights)
          .sort((a, b) => b[1] - a[1])
          .map(([repo, w]) => `${repo}(${w.toFixed(2)})`)
          .join(", ")
    );
  }

  const summary = await buildSummary({
    date,
    codexSessions,
    claudeSessions,
    slackContexts,
    gitCommits: gitData.commits,
    gitWorkingTree: gitData.workingTree,
    shellHistory,
    prBranchSignals
  });

  const dailyJsonPath = path.join(config.dataDir, "daily", `${date}.json`);
  const resumeJsonPath = path.join(config.dataDir, "resume", `${date}.json`);
  const dailyMdPath = path.join(config.vaultDir, "daily", `${date}.md`);
  const resumeMdPath = path.join(config.vaultDir, "resume", `${date}.md`);

  await Promise.all([
    writeJson(dailyJsonPath, summary),
    writeJson(resumeJsonPath, summary.resume),
    writeText(dailyMdPath, renderDailyMarkdown(summary)),
    writeText(resumeMdPath, renderResumeMarkdown(summary))
  ]);

  const { profilePath } = await buildProfileSummary(config);

  // ── Final stage: delta check + merge candidate generation (Sub-AC 10-3) ─────
  //
  // After the daily summary has been written, emit "work_log_saved" through the
  // event bus (Sub-AC 2-1).  The event bus sequentially awaits all registered
  // hooks; by default `registerResumeBatchHook()` is called from server.mjs /
  // cli.mjs to wire `runResumeCandidateHook` into the bus.
  //
  // This performs (via registered hooks):
  //   1. Extract resume-worthy updates from today's work log (LLM, cache-first)
  //   2. Merge updates into the existing resume → proposed document
  //   3. Rule-based diff to identify what changed
  //   4. Convert diff to pending SuggestionItems
  //   5. Supersede any existing pending candidates (AC 13 semantics)
  //   6. Persist updated suggestions to Vercel Blob
  //
  // The emission is intentionally non-fatal:
  //   - If no hooks are registered, a neutral skipped result is returned.
  //   - Errors inside hooks are captured and returned; the batch always
  //     completes regardless of hook outcome.
  const candidateHook = await emitWorkLogSaved(date, summary);

  return {
    ...summary,
    paths: {
      dailyJsonPath,
      resumeJsonPath,
      dailyMdPath,
      resumeMdPath,
      profilePath
    },
    candidateHook
  };
}

async function buildSummary({ date, codexSessions, claudeSessions, slackContexts, gitCommits, gitWorkingTree, shellHistory, prBranchSignals }) {
  const repoGroups = groupBy(gitCommits, "repo");
  const codexSummaries = uniqueStrings(codexSessions.map((session) => session.summary).filter(Boolean), 8);
  const claudeSummaries = uniqueStrings(claudeSessions.map((session) => session.summary).filter(Boolean), 8);
  const actionPattern = /(확인|분석|검토|정리|구현|생성|설계|추가|삭제|제거|연결|수집|파악|구축|수정|진단|통합|자동화|만들)/;
  const narrativeSnippets = [...codexSummaries, ...claudeSummaries]
    .filter((snippet) => !looksLikeQuestion(snippet))
    .filter((snippet) => actionPattern.test(snippet));
  const commandHighlights = uniqueStrings(shellHistory.map((entry) => entry.command), 12);
  const commitHighlights = gitCommits.slice(0, 12).map((commit) => `${commit.repo}: ${commit.subject}`);
  const themeSummaries = deriveThemeSummaries({
    codexSessions,
    claudeSessions,
    gitCommits
  });
  const aiSummaries = await maybeSummarizeWithOpenAI({
    date,
    gitCommits,
    shellHistory,
    codexSessions,
    claudeSessions,
    slackContexts,
    heuristicThemes: themeSummaries
  });
  const commitFirstMainWork = deriveMainWorkFromCommits(gitCommits);
  const commitFirstSupportingWork = deriveSupportingWorkFromCommits(gitCommits);
  const fallbackOutcomes = deriveBusinessOutcomesFromCommits(gitCommits);
  const finalMainWork = aiSummaries?.businessOutcomes?.length
    ? aiSummaries.businessOutcomes
    : (fallbackOutcomes.length ? fallbackOutcomes : (commitFirstMainWork.length ? commitFirstMainWork : themeSummaries.slice(0, 3)));
  const finalSupportingWork = aiSummaries?.keyChanges?.length
    ? aiSummaries.keyChanges
    : commitFirstSupportingWork;
  const finalThemeSummaries = [...finalMainWork, ...finalSupportingWork];
  const finalImpact = aiSummaries?.impact?.length ? aiSummaries.impact : deriveImpactBullets(finalThemeSummaries);
  const finalWhyItMatters = aiSummaries?.whyItMatters?.length ? aiSummaries.whyItMatters : deriveWhyItMattersBullets(finalThemeSummaries);
  const finalCommitAnalysis = deriveCommitAnalysisBullets(gitCommits);
  const sessionSignalsExist = codexSessions.length > 0 || claudeSessions.length > 0 || slackContexts.length > 0;
  const finalAiReview = aiSummaries?.aiReview?.length
    ? aiSummaries.aiReview
    : deriveAiReviewFromSignals(gitCommits, codexSessions, claudeSessions, slackContexts, sessionSignalsExist);
  const finalWorkingStyleSignals = aiSummaries?.workingStyleSignals?.length
    ? aiSummaries.workingStyleSignals
    : deriveWorkingStyleSignals({
        gitCommits,
        codexSessions,
        claudeSessions,
        slackContexts,
        aiReview: finalAiReview
      });
  const accomplishments = uniqueStrings([
    ...finalThemeSummaries,
    ...commitHighlights,
    ...narrativeSnippets
  ], 12);
  // ── Build categorized projects, priority-sorted by PR/branch weight ─────────
  //
  // Within each category (company / opensource / other), projects are sorted
  // descending by their combined pipeline weight (Sub-AC 11b: maxWeight ×
  // mention-count boost) so the LLM extraction prompt surfaces the most
  // PR-active projects first.  Projects with no PR/branch signal retain their
  // original commit-count ordering (stable sort).
  //
  // pipelineWeights already incorporate mention-count proportionality via
  // computePipelineWeight().  We fall back to projectWeights when pipelineWeights
  // are absent (backward-compat with callers that only set projectWeights).
  const weights = prBranchSignals?.projectWeights ?? {};
  const sortWeights = prBranchSignals?.pipelineWeights ?? weights;
  const rawProjects = Object.entries(repoGroups).map(([repo, commits]) => ({
    repo,
    category: classifyRepoCategory(commits[0]?.repoPath),
    commitCount: commits.length,
    commits: commits.slice(0, 10),
    prWeight: sortWeights[repo] ?? 0
  }));
  const weightSortedProjects = sortProjectsByPrWeight(rawProjects, sortWeights);
  const categorizedProjects = categorizeProjects(weightSortedProjects);
  const storyThreads = deriveStoryThreadsFromProjects(categorizedProjects, []);

  const resumeCandidates = uniqueStrings([
    ...Object.entries(repoGroups).map(([repo, commits]) => {
      const subjects = commits.slice(0, 3).map((commit) => commit.subject).join("; ");
      return `Worked on ${repo}: ${subjects}`;
    }),
    ...(aiSummaries?.resumeBullets?.length
      ? aiSummaries.resumeBullets
      : finalThemeSummaries.slice(0, 4).map((snippet) => `AI-assisted workflow: ${snippet}`))
  ], 8);
  const companyResumeCandidates = uniqueStrings(
    categorizedProjects.company.map((project) => {
      const subjects = project.commits.slice(0, 3).map((commit) => commit.subject).join("; ");
      return `${project.repo}: ${subjects}`;
    }),
    6
  );
  const openSourceResumeCandidates = uniqueStrings(
    categorizedProjects.opensource.map((project) => {
      const subjects = project.commits.slice(0, 3).map((commit) => commit.subject).join("; ");
      return `${project.repo}: ${subjects}`;
    }),
    6
  );

  return {
    date,
    counts: {
      codexSessions: codexSessions.length,
      claudeSessions: claudeSessions.length,
      slackContexts: slackContexts.length,
      gitCommits: gitCommits.length,
      companyCommits: categorizedProjects.company.reduce((sum, project) => sum + project.commitCount, 0),
      openSourceCommits: categorizedProjects.opensource.reduce((sum, project) => sum + project.commitCount, 0),
      shellCommands: shellHistory.length
    },
    highlights: {
      businessOutcomes: finalMainWork,
      keyChanges: finalSupportingWork,
      impact: finalImpact,
      whyItMatters: finalWhyItMatters,
      commitAnalysis: finalCommitAnalysis,
      aiReview: finalAiReview,
      workingStyleSignals: finalWorkingStyleSignals,
      shareableSentence: aiSummaries?.shareableSentence || '',
      storyThreads,
      mainWork: finalMainWork,
      supportingWork: finalSupportingWork,
      themeSummaries: finalThemeSummaries,
      accomplishments,
      commitHighlights,
      commandHighlights
    },
    projects: categorizedProjects.all,
    projectGroups: categorizedProjects,
    aiSessions: {
      codex: codexSessions,
      claude: claudeSessions
    },
    slack: {
      contextCount: slackContexts.length
    },
    shellHistory: shellHistory.slice(-30).reverse(),
    resume: {
      date,
      candidates: resumeCandidates,
      companyCandidates: companyResumeCandidates,
      openSourceCandidates: openSourceResumeCandidates,
      notes: aiSummaries
        ? `Generated with OpenAI model ${aiSummaries.model}. Review before applying to your canonical resume.`
        : "Review these bullets before applying them to your canonical resume."
    },
    summarization: {
      provider: aiSummaries ? "openai" : "heuristic",
      model: aiSummaries?.model || null
    },
    // ── PR/branch signals from Sub-AC 11b ─────────────────────────────────────
    // Carried through to resumeBatchHook → extractResumeUpdatesFromWorkLog
    // so the LLM extraction prompt can surface prioritized projects.
    prBranchSignals: prBranchSignals ?? { projectWeights: {}, mentions: [] }
  };
}

function renderDailyMarkdown(summary) {
  const header = [
    "---",
    `date: ${summary.date}`,
    "type: daily-log",
    "tags:",
    "  - worklog",
    "  - daily",
    "---",
    "",
    `# ${summary.date}`,
    "",
    "## Summary",
    "",
    ...(summary.highlights.storyThreads.length
      ? [
          "### Story Threads",
          ...summary.highlights.storyThreads.flatMap((story, index) => [
            `#### ${index + 1}. ${story.outcome}`,
            `- Key change: ${story.keyChange}`,
            `- Impact: ${story.impact}`,
            `- Why: ${story.why}`,
            ...(story.decision ? [`- Judgment: ${story.decision}`] : []),
            ""
          ])
        ]
      : summary.highlights.mainWork.length
      ? [
          "### Business Outcomes",
          ...summary.highlights.businessOutcomes.map((item) => `- ${item}`),
          ""
        ]
      : summary.highlights.accomplishments.map((item) => `- ${item}`)),
    ...(summary.highlights.keyChanges.length
      ? [
          "### Key Changes",
          ...summary.highlights.keyChanges.map((item) => `- ${item}`),
          ""
        ]
      : []),
    ...(summary.highlights.impact.length
      ? [
          "### Impact",
          ...summary.highlights.impact.map((item) => `- ${item}`),
          ""
        ]
      : []),
    ...(summary.highlights.whyItMatters.length
      ? [
          "### Why It Matters",
          ...summary.highlights.whyItMatters.map((item) => `- ${item}`),
          ""
        ]
      : []),
    ...(summary.highlights.aiReview.length
      ? [
          "### AI Review",
          ...summary.highlights.aiReview.map((item) => `- ${item}`),
          ""
        ]
      : []),
    ...(summary.highlights.workingStyleSignals?.length
      ? [
          "### Working Style Signals",
          ...summary.highlights.workingStyleSignals.map((item) => `- ${item}`),
          ""
        ]
      : []),
    "",
    "## Projects",
    ""
  ];

  const projectSection = summary.projects.length
    ? [
        ...renderProjectCategory("Company", summary.projectGroups.company),
        ...renderProjectCategory("Open Source", summary.projectGroups.opensource),
        ...renderProjectCategory("Other", summary.projectGroups.other)
      ]
    : ["- No git commits collected.", ""];

  const aiSection = [
    "## AI Sessions",
    "",
    `- Codex sessions: ${summary.counts.codexSessions}`,
    `- Claude Code sessions: ${summary.counts.claudeSessions}`,
    `- Slack contexts: ${summary.counts.slackContexts}`,
    "",
    "## Shell Highlights",
    "",
    ...(summary.highlights.commandHighlights.length
      ? summary.highlights.commandHighlights.map((command) => `- \`${command}\``)
      : ["- No shell history collected."]),
    "",
    `## Resume`,
    "",
    `- See [[resume/${summary.date}]]`,
    ""
  ];

  const commitAnalysisSection = summary.highlights.commitAnalysis.length
    ? [
        "## Commit Analysis",
        "",
        ...renderCommitCategory("Company", summary.projectGroups.company),
        ...renderCommitCategory("Open Source", summary.projectGroups.opensource),
        ...renderCommitCategory("Other", summary.projectGroups.other),
        ...summary.highlights.commitAnalysis.map((item) => `- ${item}`),
        ""
      ]
    : [];

  return [...header, ...projectSection, ...commitAnalysisSection, ...aiSection].join("\n");
}

function renderResumeMarkdown(summary) {
  return [
    "---",
    `date: ${summary.date}`,
    "type: resume-candidate",
    "tags:",
    "  - resume",
    "  - candidate",
    "---",
    "",
    `# Resume Candidates ${summary.date}`,
    "",
    "## Company",
    "",
    ...(summary.resume.companyCandidates.length
      ? summary.resume.companyCandidates.map((candidate) => `- ${candidate}`)
      : ["- None"]),
    "",
    "## Open Source",
    "",
    ...(summary.resume.openSourceCandidates.length
      ? summary.resume.openSourceCandidates.map((candidate) => `- ${candidate}`)
      : ["- None"]),
    "",
    "## Combined",
    "",
    ...summary.resume.candidates.map((candidate) => `- ${candidate}`),
    "",
    "## Source",
    "",
    `- Derived from [[daily/${summary.date}]]`,
    "",
    "## Review",
    "",
    `- ${summary.resume.notes}`,
    ""
  ].join("\n");
}

function groupBy(items, key) {
  return items.reduce((accumulator, item) => {
    const groupKey = item[key] ?? "unknown";
    accumulator[groupKey] ??= [];
    accumulator[groupKey].push(item);
    return accumulator;
  }, {});
}

function classifyRepoCategory(repoPath) {
  const target = String(repoPath || "");
  if (target.includes("/Documents/company-code/")) return "company";
  if (target.includes("/Documents/opensource/")) return "opensource";
  return "other";
}

function categorizeProjects(projects) {
  const grouped = {
    company: [],
    opensource: [],
    other: []
  };

  for (const project of projects) {
    const key = grouped[project.category] ? project.category : "other";
    grouped[key].push(project);
  }

  return {
    ...grouped,
    all: [...grouped.company, ...grouped.opensource, ...grouped.other]
  };
}

function renderProjectCategory(label, projects) {
  if (!projects.length) return [];
  return [
    `### ${label}`,
    ...projects.flatMap((project) => [
      `#### ${project.repo}`,
      ...project.commits.map((commit) => `- ${commit.subject} \`${commit.hash}\``),
      ""
    ])
  ];
}

function renderCommitCategory(label, projects) {
  if (!projects.length) return [];
  const total = projects.reduce((sum, project) => sum + project.commitCount, 0);
  const repoNames = projects.map((project) => project.repo).join(", ");
  return [`- ${label}: ${total} commits across ${repoNames}`];
}

function deriveThemeSummaries({ codexSessions, claudeSessions, gitCommits }) {
  const corpus = [
    ...codexSessions.flatMap((session) => [session.summary, ...(session.snippets || [])]),
    ...claudeSessions.flatMap((session) => [session.summary, ...(session.snippets || [])]),
    ...gitCommits.map((commit) => commit.subject)
  ]
    .filter(Boolean)
    .join("\n");

  const summaries = [];

  if (/(ouroboros|ooo|mcp)/i.test(corpus) && /(codex|wrapper|session[_ -]?id|interview)/i.test(corpus)) {
    summaries.push("Ouroboros를 Codex MCP 흐름에 붙이는 방법과 interview wrapper/session 관리 문제를 분석했다.");
  }

  if (/(work-log|업무.?로그|일일 회고|resume|이력서)/i.test(corpus) && /(obsidian|dashboard|웹앱|cli|batch|vault)/i.test(corpus)) {
    summaries.push("세션 로그를 모아 업무로그, 일일 회고, 이력서 후보를 만드는 work-log 앱 구조를 정리했다.");
  }

  if (/(tgs140|tgs138|tgs136|deposit|admission|셀프.?체크인|예약금)/i.test(corpus)) {
    summaries.push("예약금 결제 알림과 admission/self-check-in 메시지 플로우를 분석했다.");
  }

  return summaries;
}

function deriveImpactBullets(themeSummaries) {
  const joined = themeSummaries.join(" ");
  const bullets = [];

  if (/(업무로그|일일 회고|이력서 후보|work-log)/.test(joined)) {
    bullets.push("하루 작업을 회상에 의존하지 않고 구조화된 기록으로 남길 수 있는 기반을 만들었다.");
  }
  if (/(mcp|wrapper|세션 관리|interview)/i.test(joined)) {
    bullets.push("도구 연결 문제와 UX 문제를 분리해, 실제 병목을 더 빠르게 진단할 수 있게 했다.");
  }
  if (/(예약금|admission|self-check-in|메시지)/.test(joined)) {
    bullets.push("사용자 커뮤니케이션 플로우의 누락이나 중복 발송 위험을 줄일 수 있는 판단 근거를 확보했다.");
  }

  return bullets.slice(0, 3);
}

function deriveWhyItMattersBullets(themeSummaries) {
  const joined = themeSummaries.join(" ");
  const bullets = [];

  if (/(업무로그|이력서 후보|work-log)/.test(joined)) {
    bullets.push("나중에 회고하거나 이력서를 갱신할 때, 실제 작업 근거를 다시 뒤지지 않아도 되게 해준다.");
  }
  if (/(mcp|wrapper|세션 관리|interview)/i.test(joined)) {
    bullets.push("문제가 서버인지 프롬프트 래퍼인지 구분해야 불필요한 재설치나 우회 작업을 줄일 수 있다.");
  }
  if (/(예약금|admission|self-check-in|메시지)/.test(joined)) {
    bullets.push("메시지 트리거와 상태 전이를 정확히 이해해야 사용자 경험과 운영 정확도를 함께 지킬 수 있다.");
  }

  return bullets.slice(0, 3);
}

function deriveCommitAnalysisBullets(gitCommits) {
  const byRepo = groupBy(gitCommits, "repo");

  return Object.entries(byRepo)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 4)
    .map(([repo, commits]) => summarizeCommitAnalysis(repo, commits));
}

function summarizeCommitAnalysis(repo, commits) {
  const subjects = commits.map((commit) => commit.subject).join(" ");
  const lower = subjects.toLowerCase();
  const count = commits.length;

  if (repo === "driving-teacher-frontend") {
    const focus = [];
    if (/(react|web|ui|dialog|lottie|getstaticprops|router|kakao sdk|cache)/i.test(subjects)) {
      focus.push("React/Next.js 웹 프론트엔드");
    }
    if (/(erp|체크인|예약|환불|merchant key|admission|deposit)/.test(subjects)) {
      focus.push("ERP 예약·체크인 흐름");
    }
    if (/(셔틀|정류장|gps|지도|route|shuttle)/.test(subjects)) {
      focus.push("셔틀/GPS 지도 로직");
    }
    const domain = focus.length ? focus.join(", ") : "웹 프론트엔드";
    return `${repo}에서 ${domain}를 다루며 안정화, 예외 처리, 운영 흐름 개선 작업을 진행했다.`;
  }

  if (repo === "kakao-novel-generator") {
    const tech = /(causal graph|why-chain|deterministic|blueprint|scene|plot)/i.test(lower)
      ? "서사 검증·제어 파이프라인"
      : "생성 파이프라인";
    return `${repo}에서 ${tech}을 고도화해 개연성, 중복 제어, 출력 형식 안정성을 개선했다.`;
  }

  if (repo === "ouroboros") {
    const tech = /(loop|resume|state|install|dependency|security|docs)/i.test(lower)
      ? "에이전트 루프·resume·설치 흐름"
      : "에이전트 실행 인프라";
    return `${repo}에서 ${tech}를 다루며 재시도 안정성, 설치 경로, 보안/의존성 이슈를 정리했다.`;
  }

  if (repo === "ouroboros-family") {
    return `${repo}에서 PR 리뷰 자동화와 git safety 흐름을 다듬어 검토 신뢰도를 높였다.`;
  }

  if (repo === "neo-fetch") {
    return `${repo}에서 데이터 매칭 로직을 보완해 route와 shuttle 매핑 정확도를 높였다.`;
  }

  const types = [];
  if (/\bfix\b|fix\(/i.test(lower)) types.push("안정화");
  if (/\brefactor\b|refactor\(/i.test(lower)) types.push("구조 개선");
  if (/\bfeat\b|feature|feat\(/i.test(lower)) types.push("기능 추가");
  if (/\bdocs\b|docs\(/i.test(lower)) types.push("문서 개선");
  const summary = types.length ? types.join(", ") : "기술 개선";
  return `${repo}에서 ${count}개의 커밋을 통해 ${summary} 작업을 진행했다.`;
}

function deriveAiReviewFromSignals(gitCommits, codexSessions, claudeSessions, slackContexts = [], sessionSignalsExist = false) {
  const review = [];
  const byRepo = groupBy(gitCommits, "repo");

  if ((byRepo["driving-teacher-frontend"] || []).length >= 5) {
    review.push("운영 이슈를 기능 추가보다 안정화와 예외 처리 관점에서 푸는 경향이 강하게 보인다.");
  }

  if ((byRepo["kakao-novel-generator"] || []).length > 0 || (byRepo["ouroboros"] || []).length > 0) {
    review.push("제품 실무와 오픈소스 개선을 병행하면서 문제를 구조적으로 다루는 편이다.");
  }

  if (sessionSignalsExist) {
    const candidates = uniqueStrings([
      ...codexSessions.flatMap((session) => [session.summary, ...(session.snippets || [])]),
      ...claudeSessions.flatMap((session) => [session.summary, ...(session.snippets || [])]),
      ...slackContexts.map((entry) => entry.text)
    ], 20);

    const filtered = candidates
      .filter(Boolean)
      .filter((text) => !looksLikeQuestion(text))
      .filter((text) => !/[!@]/.test(text))
      .filter((text) => !/(부탁|로그인 부탁|주세요)/.test(text))
      .slice(0, 1)
      .map((text) => summarizeDecisionCandidate(text));

    if (filtered[0]) {
      review.push(filtered[0]);
    }
  }

  review.push("이력서에는 운영 안정화, 예외 처리, 복잡한 흐름 정리 역량을 전면에 두는 게 가장 설득력 있다.");
  return review.slice(0, 4);
}

function deriveWorkingStyleSignals({
  gitCommits,
  codexSessions,
  claudeSessions,
  slackContexts = [],
  aiReview = []
}) {
  const signals = [];
  const texts = uniqueStrings([
    ...slackContexts.map((entry) => entry.text),
    ...slackContexts.flatMap((entry) => entry.context || []),
    ...codexSessions.flatMap((session) => [session.summary, ...(session.snippets || [])]),
    ...claudeSessions.flatMap((session) => [session.summary, ...(session.snippets || [])]),
    ...aiReview,
    ...gitCommits.map((commit) => commit.subject)
  ], 40).join(" ");

  if (/(설문|기대|정렬|로드맵|현실적 목표|기대치)/.test(texts)) {
    signals.push("기대치와 실제 결과의 간극을 먼저 줄이려는 편이다.");
  }
  if (/(노이즈|필터|beforeSend|Sentry|잡음|가시성|운영)/i.test(texts)) {
    signals.push("운영 신호의 잡음을 줄여 판단 비용을 낮추는 방향을 선호한다.");
  }
  if (/(흐름|구조|재정비|재구성|파이프라인|블루프린트|timeline|workflow)/i.test(texts)) {
    signals.push("개별 수정 대신 전체 흐름과 구조를 함께 정리하려는 성향이 있다.");
  }
  if (/(브랜드|표현|일관성|quality|품질|자연스럽)/i.test(texts)) {
    signals.push("완성도 기준을 말로 정리하고 결과물의 일관성을 끝까지 챙기는 편이다.");
  }
  if (/(도입|먼저|priorit|정교|리스크|위험|guard|예외)/i.test(texts)) {
    signals.push("리스크를 먼저 좁히고 그 위에 기능이나 경험을 쌓는 판단 패턴이 보인다.");
  }

  return uniqueStrings(signals, 5);
}

function deriveBusinessOutcomesFromCommits(gitCommits) {
  const byRepo = groupBy(gitCommits, "repo");
  const bullets = [];

  for (const [repo, commits] of Object.entries(byRepo)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3)) {
    const subjects = commits.map((commit) => commit.subject).join(" ");

    if (repo === "driving-teacher-frontend") {
      if (/(체크인|예약 성공|deposit|admission|merchant key|환불)/.test(subjects)) {
        bullets.push("예약·결제·체크인 흐름의 누락과 오작동 가능성을 줄였다.");
        continue;
      }
      if (/(gps|지도|셔틀|정류장|qa|cache|lottie|getstaticprops|router|kakao sdk)/i.test(subjects)) {
        bullets.push("운영 화면과 셔틀 흐름의 안정성을 높여 현장 사용성을 개선했다.");
        continue;
      }
    }

    if (repo === "kakao-novel-generator") {
      bullets.push("서사 생성 결과의 개연성과 형식 안정성을 높일 기반을 마련했다.");
      continue;
    }

    if (repo === "ouroboros") {
      bullets.push("에이전트 루프와 재개 흐름의 신뢰도를 높여 도구 운영 안정성을 개선했다.");
      continue;
    }

    if (repo === "ouroboros-family") {
      bullets.push("PR 리뷰와 git safety 흐름을 다듬어 검토 신뢰도를 높였다.");
      continue;
    }

    bullets.push(`${repo} 관련 작업의 운영 안정성과 개발 생산성을 개선했다.`);
  }

  return bullets;
}

function deriveStoryThreadsFromProjects(categorizedProjects, decisionNotes = []) {
  const projects = [...categorizedProjects.company, ...categorizedProjects.opensource]
    .sort((a, b) => {
      const rank = (project) => (project.category === "company" ? 0 : project.category === "opensource" ? 1 : 2);
      return rank(a) - rank(b) || b.commitCount - a.commitCount;
    })
    .slice(0, 3);

  return projects.map((project, index) => summarizeProjectStory(project, decisionNotes[index] || ""));
}

function summarizeProjectStory(project, decision = "") {
  const subjects = project.commits.map((commit) => commit.subject).join(" ");
  const repo = project.repo;

  if (repo === "driving-teacher-ai-native") {
    return {
      repo,
      outcome: synthesizeStoryOutcome(subjects, [
        {
          test: /(설문|로드맵|커리큘럼|숙제-스킬|브랜드 디자인|현실적 목표)/,
          outcome: "AI 캠프 커리큘럼과 기대치 정렬 흐름을 재설계함"
        },
        {
          test: /(gdrive|mcp|도메인 지식 플로우)/i,
          outcome: "AI 캠프 운영을 위한 도메인 지식 흐름을 정비함"
        }
      ], "학습 경험의 현실성과 안내 정확도를 높이는 흐름을 다듬음"),
      keyChange: synthesizeKeyChange(subjects, [
        /(설문|로드맵|커리큘럼|숙제-스킬|브랜드 디자인|현실적 목표)/,
        /(gdrive|mcp|도메인 지식 플로우)/i
      ]),
      impact: "학습자 기대치와 실제 진행 흐름이 더 잘 맞도록 조정함",
      why: "초기 안내와 실제 학습 경험의 오차를 줄여 운영 커뮤니케이션 비용을 낮춤",
      decision
    };
  }

  if (repo === "driving-teacher-frontend") {
    if (/(체크인|예약 성공|deposit|admission|merchant key|환불)/.test(subjects)) {
      return {
        repo,
        outcome: "예약·결제·체크인 흐름의 오작동 가능성을 줄임",
        keyChange: "체크인 상태 노출과 merchant key/환불 처리 분기를 정리",
        impact: "운영자가 결제와 체크인 상태를 더 정확하게 확인함",
        why: "실결제와 후속 안내 누락을 줄여 운영 신뢰도를 높임",
        decision
      };
    }

    if (/(gps|지도|셔틀|정류장|qa|cache|lottie|getstaticprops|router|kakao sdk)/i.test(subjects)) {
      return {
        repo,
        outcome: "셔틀·지도·QA 흐름의 안정성을 높임",
        keyChange: "GPS 인식 범위와 순서를 보정하고 지도/SDK 가드를 추가",
        impact: "운영 화면의 오류와 테스트 중 잡음을 줄임",
        why: "현장 사용성과 QA 신뢰도를 동시에 개선함",
        decision
      };
    }
  }

  if (repo === "kakao-novel-generator") {
    return {
      repo,
      outcome: "서사 생성 결과의 개연성과 형식 안정성을 높임",
      keyChange: "causal graph·why-chain·deterministic control 파이프라인을 강화",
      impact: "허용도 낮은 결과와 메타 출력이 줄어듦",
      why: "생성 품질이 올라가면 후속 검수 비용이 줄어듦",
      decision
    };
  }

  if (repo === "ouroboros") {
    return {
      repo,
      outcome: "에이전트 루프와 재개 흐름의 신뢰성을 높임",
      keyChange: "loop/state restore/install 경로의 결함을 연속적으로 수정",
      impact: "재시도·재개·설치 과정에서 실패 가능성을 줄임",
      why: "도구 운영 안정성이 좋아지면 반복 작업 비용이 감소함",
      decision
    };
  }

  return {
    repo,
    outcome: synthesizeStoryOutcome(subjects, [], `${repo}에서 진행한 핵심 흐름을 정리하고 개선함`),
    keyChange: synthesizeKeyChange(subjects),
    impact: "주요 기능 흐름의 오류 가능성을 줄임",
    why: "운영과 개발 모두에서 예외 상황 대응 비용을 줄일 수 있음",
    decision
  };
}

function synthesizeStoryOutcome(subjects, rules = [], fallback) {
  for (const rule of rules) {
    if (rule.test.test(subjects)) return rule.outcome;
  }

  if (/(filter|노이즈|sentry|beforeSend)/i.test(subjects)) {
    return "운영 노이즈를 줄이고 판단 신호를 더 선명하게 만듦";
  }
  if (/(qa|guard|retry|resume|stability|안정|예외)/i.test(subjects)) {
    return "불안정한 흐름을 더 안전하게 운영할 수 있도록 정리함";
  }
  if (/(roadmap|survey|curriculum|커리큘럼|설문|로드맵)/i.test(subjects)) {
    return "기대치와 실제 흐름이 어긋나지 않도록 운영 구조를 조정함";
  }
  if (/(rewriter|timeline|blueprint|scene|story|서사|소설)/i.test(subjects)) {
    return "생성 결과의 흐름과 품질이 더 자연스럽게 이어지도록 다듬음";
  }
  if (/(brand|design|리브랜딩|표현|일관성)/i.test(subjects)) {
    return "브랜드 표현과 사용자 경험의 일관성을 높이는 방향으로 정리함";
  }

  return fallback;
}

function synthesizeKeyChange(subjects, preferredPatterns = []) {
  const commits = subjects
    .split(/(?:(?<=\))\s+|;\s+)/)
    .map((text) => cleanCommitSubject(text))
    .filter(Boolean);

  const joined = commits.join(" ");

  if (preferredPatterns.length > 0) {
    const preferred = commits.filter((subject) =>
      preferredPatterns.some((pattern) => pattern.test(subject))
    );
    const summarized = summarizeCommitChanges(preferred);
    if (summarized) return summarized;
  }

  const summarized = summarizeCommitChanges(commits);
  if (summarized) return summarized;

  for (const pattern of preferredPatterns) {
    const hit = commits.find((subject) => pattern.test(subject));
    if (hit) return cleanCommitSubject(hit);
  }

  if (/(설문|로드맵|커리큘럼|숙제-스킬|브랜드 디자인|현실적 목표)/.test(joined)) {
    return "사전 설문, 로드맵, 커리큘럼 흐름을 함께 손봐 학습 안내 구조를 다시 정리";
  }
  if (/(sentry|filter|beforeSend|retry|offline|오프라인|노이즈)/i.test(joined)) {
    return "오류 필터와 예외 대응 설정을 조정해 운영 신호를 더 안정적으로 관리";
  }
  if (/(timeline|blueprint|rewriter|scene|dedup|중복|서사|소설)/i.test(joined)) {
    return "서사 생성 파이프라인의 구조와 후처리 규칙을 다듬어 출력 품질을 개선";
  }

  return cleanCommitSubject(commits[0] || subjects);
}

function cleanCommitSubject(subject) {
  return String(subject || "")
    .replace(/^([A-Z]+|\w+)(\([^)]+\))?:\s*/i, "")
    .replace(/\s*\(#\d+\)\s*$/, "")
    .trim();
}

function summarizeCommitChanges(commits) {
  const joined = commits.join(" ");
  if (!joined) return "";

  if (/(설문|로드맵|커리큘럼|숙제-스킬|브랜드 디자인|현실적 목표)/.test(joined)) {
    return "사전 설문, 로드맵, 커리큘럼 구성을 함께 조정해 학습 흐름을 재정비";
  }
  if (/(block 1|block 3|think-deeper|onboarding|README|SETUP|설명|안내|채널명)/i.test(joined)) {
    return "온보딩 단계와 안내 문구를 다시 짜서 처음 따라오는 흐름을 단순화";
  }
  if (/(windows|fnm|homebrew|path|인코딩|설치 스크립트|개인 계정|mcp)/i.test(joined)) {
    return "설치 스크립트와 환경별 가이드를 정리해 세팅 실패 지점을 줄임";
  }
  if (/(sentry|filter|beforeSend|retry|offline|오프라인|노이즈)/i.test(joined)) {
    return "오류 필터와 예외 대응 설정을 묶어 운영 노이즈와 장애 탐지 흐름을 정리";
  }
  if (/(tablet|가로 모드|responsive|breakpoint|layout)/i.test(joined)) {
    return "레이아웃 기준값을 조정해 태블릿 환경의 화면 전환 동작을 안정화";
  }
  if (/(timeline|blueprint|rewriter|scene|dedup|중복|서사|소설|5w1h|opening_context)/i.test(joined)) {
    return "서사 생성 구조와 리라이트 규칙을 함께 다듬어 결과물의 개연성과 읽기 흐름을 개선";
  }
  if (/(deprecated|studentId|csv)/i.test(joined)) {
    return "중복 학생 판별 로직을 바로잡아 데이터 정합성과 최신 레코드 판별을 안정화";
  }

  return "";
}

function summarizeDecisionCandidate(text) {
  const cleaned = String(text || "")
    .replace(/:[a-z0-9_+-]+:/gi, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (/(firebase|구글 로그인|google login|인증|login)/i.test(cleaned) && /(병목|불편|우회|키|세팅)/i.test(cleaned)) {
    return "Firebase/구글 로그인 병목을 줄이기 위한 인증 설정 우회 방식을 검토했다.";
  }

  if (/(mcp|wrapper|session|세션)/i.test(cleaned) && /(병목|문제|재사용|오동작|흐름)/i.test(cleaned)) {
    return "도구 연결 흐름에서 세션 재사용과 래퍼 병목을 점검했다.";
  }

  if (/(결제|체크인|알림톡|merchant key|환불)/i.test(cleaned) && /(방향|정리|판단|검토)/i.test(cleaned)) {
    return "결제·체크인 흐름에서 어떤 지점에 안내와 상태 반영을 둘지 판단했다.";
  }

  return cleaned.slice(0, 120).trim();
}

function deriveMainWorkFromCommits(gitCommits) {
  const byRepo = groupBy(gitCommits, "repo");
  const bullets = [];

  for (const [repo, commits] of Object.entries(byRepo)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3)) {
    const subjects = commits.map((commit) => commit.subject).join(" ");
    bullets.push(summarizeRepoWork(repo, subjects, commits.length));
  }

  return bullets;
}

function deriveSupportingWorkFromCommits(gitCommits) {
  const byRepo = groupBy(gitCommits, "repo");
  return Object.entries(byRepo)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(3, 5)
    .map(([repo, commits]) => summarizeRepoWork(repo, commits.map((commit) => commit.subject).join(" "), commits.length));
}

function summarizeRepoWork(repo, subjects, count) {
  const lower = subjects.toLowerCase();

  if (repo === "driving-teacher-frontend") {
    if (/(체크인|예약 성공|self-check|admission|deposit)/.test(subjects)) {
      return `${repo}에서 체크인/예약 성공 플로우와 관련 UI·메시지 동작을 정리했다.`;
    }
    if (/(qa|gps|지도|cache|lottie|getstaticprops|router\.push|kakao sdk)/i.test(subjects)) {
      return `${repo}에서 QA/지도/라우팅/캐시 안정화 이슈를 수정했다.`;
    }
  }

  if (repo === "kakao-novel-generator") {
    return `${repo}에서 서사 생성 제어와 포맷 안정화 로직을 다듬었다.`;
  }

  if (repo === "ouroboros") {
    return `${repo}에서 loop/resume/state restore 관련 안정화 작업을 진행했다.`;
  }

  if (repo === "ouroboros-family") {
    return `${repo}에서 PR 리뷰와 git safety 흐름을 개선했다.`;
  }

  const topic = subjects
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .join(" ");
  return `${repo}에서 ${count}개의 커밋을 통해 ${topic} 관련 작업을 진행했다.`;
}

async function maybeSummarizeWithOpenAI({
  date,
  gitCommits,
  shellHistory,
  codexSessions,
  claudeSessions,
  slackContexts,
  heuristicThemes
}) {
  // ── 1. Check cache before calling the LLM ─────────────────────────────────
  // Cache key is the date string.  For a given date the input corpus is
  // effectively stable once the batch has run, so this avoids redundant
  // reprocessing when the same day is re-batched (e.g. CI reruns, manual
  // re-triggers, or the API-based re-generation flow).
  try {
    const cached = await readBulletCache(date);
    if (cached) {
      return {
        ...cached,
        model: process.env.WORK_LOG_OPENAI_MODEL || "gpt-5.4-mini"
      };
    }
  } catch {
    // Cache read failure is non-fatal — fall through to live generation.
  }

  // ── 2. Build payload and call the LLM ─────────────────────────────────────
  const payload = {
    date,
    heuristic_themes: heuristicThemes,
    git_commits: gitCommits.slice(0, 20).map((commit) => ({
      repo: commit.repo,
      subject: commit.subject
    })),
    shell_commands: shellHistory.slice(-20).map((entry) => entry.command),
    codex_sessions: codexSessions.slice(0, 12).map((session) => ({
      summary: session.summary,
      evidence: (session.snippets || []).slice(0, 2)
    })),
    claude_sessions: claudeSessions.slice(0, 12).map((session) => ({
      summary: session.summary,
      evidence: (session.snippets || []).slice(0, 2)
    })),
    slack_contexts: (slackContexts || []).slice(0, 12).map((entry) => ({
      text: String(entry.text || "").slice(0, 280),
      context: Array.isArray(entry.context)
        ? entry.context
            .map((text) => String(text || "").trim())
            .filter(Boolean)
            .slice(0, 3)
        : []
    }))
  };

  let result;
  try {
    result = await summarizeWithOpenAI(payload);
    if (!result) return null;
  } catch {
    return null;
  }

  // ── 3. Persist result to cache for future re-runs of the same date ─────────
  // writeBulletCache swallows its own errors, so this is always non-fatal.
  await writeBulletCache(date, result);

  return {
    ...result,
    model: process.env.WORK_LOG_OPENAI_MODEL || "gpt-5.4-mini"
  };
}
