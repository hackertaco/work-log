import path from "node:path";

import { readBulletCache, writeBulletCache } from "./bulletCache.mjs";
import { readSuggestionsData, saveBatchSummary, saveWorklogDaily, saveWorklogProfile } from "./blob.mjs";
import { loadConfig, zeudeEmailsOf } from "./config.mjs";
import { groupPromptsByRepo } from "./dayStory.mjs";
import { getLlmModel } from "./llmGateway.mjs";
import { buildUsageCoaching } from "./usageCoaching.mjs";
import { areaKey } from "./workAreaGrouping.mjs";
import { summarizeWithOpenAI } from "./openai.mjs";
import { buildProfileSummary } from "./profile.mjs";
import { buildBatchSummary } from "./resumeBatchSummary.mjs";
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

export async function runDailyBatch(inputDate, options = {}) {
  const date = parseDateArg(inputDate);
  const config = await loadConfig({ userId: options.userId });

  await Promise.all([
    ensureDir(config.vaultDir),
    ensureDir(config.dataDir)
  ]);

  const [codexSessions, claudeSessions, slackContexts, gitData, shellHistory] = await Promise.all([
    config.includeSessionLogs ? collectCodexSessions(config, date) : Promise.resolve([]),
    config.includeSessionLogs ? collectClaudeSessions(config, date) : Promise.resolve([]),
    config.includeSlack ? collectSlackContexts(config, date) : Promise.resolve([]),
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
  // These are opt-in because the local server also listens to them to schedule
  // a batch. Emitting by default would make an ordinary batch schedule a
  // duplicate five seconds later (and used to create an unbounded loop).
  if (options.emitGranularEvents === true) {
    emitCommitCollected(date, gitData.commits, config.userId);
    if (config.includeSlack) emitSlackCollected(date, slackContexts, config.userId);
    if (config.includeSessionLogs) {
      emitSessionCollected(date, [...codexSessions, ...claudeSessions], config.userId);
    }
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
    prBranchSignals,
    allowLlm: options.allowLlm === true
  });

  // 내 사용 습관 코칭. 본인 것만 보고 다른 사람과 비교하지 않는다(usageCoaching.mjs 주석 참고).
  // 최근 7일 창으로 보는 이유: 하루치는 표본이 너무 작아 임계값이 우연히 넘거나 안 넘는다.
  // 조회가 실패하면 null 이고, 화면은 이 절을 아예 그리지 않는다.
  summary.usageCoaching = await buildUsageCoaching({ emails: zeudeEmailsOf(config), days: 7 });

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

  const { profile, profilePath } = await buildProfileSummary(config);

  // ── Blob sync: 배포 사이트가 로컬 수집 결과를 읽을 수 있게 미러링 ──────────
  // 로컬 디스크가 원본이고 Blob은 조회용 사본이다. 오프라인이거나 토큰이
  // 없으면 배치는 그대로 성공해야 하므로 실패는 경고로만 남긴다.
  let blobSync = { synced: false };
  try {
    await saveWorklogDaily(date, summary, config.userId);
    await saveWorklogProfile(profile, config.userId);
    blobSync = { synced: true };
  } catch (err) {
    const message = err.message ?? String(err);
    console.warn(`[batch date="${date}"] work-log Blob sync failed (non-fatal):`, message);
    blobSync = { synced: false, error: message };
  }

  // ── Final stage: delta check + merge candidate generation (Sub-AC 10-3) ─────
  //
  // After the daily summary has been written, emit "work_log_saved" through the
  // event bus (Sub-AC 2-1). Hooks are never registered automatically: draft or
  // candidate generation must be initiated through its explicit local surface.
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
  const candidateHook = await emitWorkLogSaved(date, summary, config.userId);

  let suggestionsDoc = null;
  try {
    suggestionsDoc = await readSuggestionsData();
  } catch (err) {
    console.warn(`[batch date="${date}"] Failed to read suggestions for batch summary:`, err.message ?? String(err));
  }

  const batchSummary = buildBatchSummary({
    date,
    summary,
    candidateHook,
    suggestionsDoc,
  });

  try {
    await saveBatchSummary(date, batchSummary);
  } catch (err) {
    console.warn(`[batch date="${date}"] Failed to save batch summary:`, err.message ?? String(err));
  }

  return {
    ...summary,
    paths: {
      dailyJsonPath,
      resumeJsonPath,
      dailyMdPath,
      resumeMdPath,
      profilePath
    },
    candidateHook,
    batchSummary,
    blobSync,
  };
}

// serverCollect.mjs 가 원격 소스(GitHub API·Zeude)로 같은 요약을 만들 때 재사용한다.
export async function buildSummary({ date, codexSessions, claudeSessions, slackContexts, gitCommits, gitWorkingTree, shellHistory, prBranchSignals, dayPrompts = [], allowLlm = false }) {
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

  // Build the project view before enrichment so the single daily LLM request
  // can return both the top-level summary and project story cards.
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
  const storyProjects = buildStoryProjectInputs({ categorizedProjects, dayPrompts });

  const aiSummaries = allowLlm
    ? await maybeSummarizeWithOpenAI({
        date,
        gitCommits,
        shellHistory,
        codexSessions,
        claudeSessions,
        slackContexts,
        heuristicThemes: themeSummaries,
        storyProjects
      })
    : null;
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
  const storyThreads = buildStoryThreads({
    categorizedProjects,
    dayPrompts,
    generatedStories: aiSummaries?.stories
  });

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
      // 그날 기록에 "열어둔 채 끝난 것"만 담는다. 내일 할 일 예측이 아니라,
      // 실제로 미뤄졌거나 답을 못 받은 것 — 없으면 빈 배열이다.
      openThreads: aiSummaries?.openThreads ?? [],
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

export function buildStoryProjectInputs({ categorizedProjects, dayPrompts }) {
  const promptsByRepo = groupPromptsByRepo(dayPrompts, areaKey);
  const fallback = deriveStoryThreadsFromProjects(categorizedProjects, [], promptsByRepo);
  if (!fallback.length) return [];

  const commitsByRepo = new Map(
    [...categorizedProjects.company, ...categorizedProjects.opensource]
      .map((p) => [p.repo, (p.commits ?? []).map((c) => c.subject)])
  );

  return fallback.slice(0, 3).map((thread) => ({
    repo: thread.repo,
    commits: commitsByRepo.get(thread.repo) ?? [],
    prompts: (promptsByRepo.get(thread.repo) ?? []).slice(0, 20)
  }));
}

/**
 * 그날의 스토리 카드를 만든다. 단일 일일 요약 응답에서 모델 스토리를 받아
 * 사실 기반 폴백에 덮어쓴다. 모델이 모르는 레포를 추가하는 것은 허용하지 않는다.
 */
function buildStoryThreads({ categorizedProjects, dayPrompts, generatedStories }) {
  const promptsByRepo = groupPromptsByRepo(dayPrompts, areaKey);
  const fallback = deriveStoryThreadsFromProjects(categorizedProjects, [], promptsByRepo);
  return mergeGeneratedStories(fallback, generatedStories);
}

export function mergeGeneratedStories(fallback, generatedStories) {
  if (!Array.isArray(generatedStories) || !generatedStories.length) return fallback;

  const byRepo = new Map(generatedStories.map((story) => [story.repo, story]));
  return fallback.map((thread) => {
    const story = byRepo.get(thread.repo);
    if (!story) return thread;
    return { ...thread, ...story, decision: thread.decision };
  });
}

/**
 * LLM 이 없을 때 쓰는 사실 기반 폴백.
 *
 * 예전에는 레포별 if 문에 미리 써둔 문장을 키워드로 골랐고, 목록에 없는 레포는
 * "<레포>에서 진행한 핵심 흐름을 정리하고 개선함" 으로 떨어졌다. impact/why 는
 * 모든 날 같은 상수였다. 어떤 날에 갖다 놔도 참인 문장이라 아무것도 알려주지 못했다.
 *
 * 그래서 지어내지 않는다. 실제 커밋 제목을 그대로 쓰고, 모르는 칸은 비운다.
 * 화면은 빈 칸을 감추게 되어 있어, 빈 칸이 그럴듯한 거짓말보다 낫다.
 */
export function deriveStoryThreadsFromProjects(categorizedProjects, decisionNotes = [], promptsByRepo = new Map()) {
  const byRepo = new Map();
  const rank = (project) => (project.category === "company" ? 0 : project.category === "opensource" ? 1 : 2);

  for (const project of [...categorizedProjects.company, ...categorizedProjects.opensource]) {
    byRepo.set(project.repo, {
      repo: project.repo,
      rank: rank(project),
      commitCount: project.commitCount ?? 0,
      subjects: (project.commits ?? []).map((c) => cleanCommitSubject(c.subject)).filter(Boolean),
      promptCount: 0
    });
  }

  // 커밋이 없어도 그날 그 레포에서 프롬프트를 많이 남겼다면 그건 일한 것이다.
  // 커밋만 세면 AI 로 일한 날이 통째로 빈손으로 보인다(2026-08-03: 커밋 2, 프롬프트 91).
  for (const [repo, prompts] of promptsByRepo) {
    if (repo === "unknown") continue;
    const entry = byRepo.get(repo) ?? { repo, rank: 2, commitCount: 0, subjects: [], promptCount: 0 };
    entry.promptCount = prompts.length;
    byRepo.set(repo, entry);
  }

  return [...byRepo.values()]
    .sort((a, b) => a.rank - b.rank || b.commitCount - a.commitCount || b.promptCount - a.promptCount)
    .slice(0, 3)
    .map((entry, index) => ({
      repo: entry.repo,
      // 커밋 제목이 그날에만 참인 유일한 문장이다. 그것도 없으면 지어내지 않는다.
      outcome: entry.subjects[0] || `${entry.repo} 작업`,
      keyChange: entry.subjects.slice(0, 3).join(" / "),
      impact: "",
      why: "",
      decision: decisionNotes[index] || ""
    }));
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
  heuristicThemes,
  storyProjects
}) {
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
    story_projects: storyProjects,
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
  const model = getLlmModel();
  const cacheContext = { input: payload, model };

  // ── 1. Check cache before calling the LLM ─────────────────────────────────
  // The key includes user, model, schema, and the exact normalized input hash.
  // Production Blob read failures throw instead of silently spending on a
  // cache-bypassing live request.
  const cached = await readBulletCache(date, cacheContext);
  if (cached) {
    return { ...cached, model };
  }

  // ── 2. Call the LLM ───────────────────────────────────────────────────────

  let result;
  try {
    result = await summarizeWithOpenAI(payload);
    if (!result) return null;
  } catch {
    return null;
  }

  // ── 3. Persist result to cache for future re-runs of the same date ─────────
  // writeBulletCache swallows its own errors, so this is always non-fatal.
  await writeBulletCache(date, result, cacheContext);

  return {
    ...result,
    model
  };
}
