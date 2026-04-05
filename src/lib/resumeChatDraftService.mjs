/**
 * resumeChatDraftService.mjs
 *
 * 채팅 기반 이력서 구체화를 위한 초안 생성 서비스 로직.
 *
 * 업무 로그 데이터 소스(커밋/슬랙/세션 메모리)에서 강점 후보와 경력별 주요 경험을
 * 추출·요약하여 대화형 이력서 다듬기의 시작점을 제공한다.
 *
 * ─── 아키텍처 ─────────────────────────────────────────────────────────────────
 *
 *   이 서비스는 기존 모듈을 재활용하여 3단계로 동작한다:
 *
 *   1. collectEvidenceForDraft(dateRange)
 *      → 업무 로그에서 커밋/슬랙/세션 메모리를 소스별로 분류·수집
 *      → resumeChatSearch.searchAllSources 로 근거 풀 생성
 *
 *   2. buildDraftWithEvidence(evidence, existingResume?)
 *      → aggregateSignals + LLM 호출로 강점 후보 + 경력별 요약 생성
 *      → 근거가 부족하면 dataGaps 를 채워 사용자에게 보충 질문 유도
 *
 *   3. refineSectionWithChat(section, userMessage, draft, evidence, resume)
 *      → 대화 맥락에서 특정 섹션의 불릿/요약을 근거 기반으로 개선
 *      → 근거 없이 허구를 생성하지 않음 — 부족 시 clarifications 반환
 *
 * ─── 핵심 타입 ─────────────────────────────────────────────────────────────────
 *
 *   DraftContext — {
 *     draft:             ResumeDraft,       // 초안 (강점 후보 + 경력 요약)
 *     evidencePool:      EvidenceItem[],    // 소스별 근거 풀
 *     sourceBreakdown:   SourceBreakdown,   // 소스별 통계
 *   }
 *
 *   EvidenceItem — {
 *     source:   "commits" | "slack" | "sessions",
 *     date:     string,                      // YYYY-MM-DD
 *     text:     string,                      // 원문 또는 요약
 *     score:    number,                      // 키워드 매칭 점수 (0–1)
 *     repo?:    string,                      // 커밋 소스일 경우
 *   }
 *
 *   SectionRefinement — {
 *     section:         string,               // 대상 섹션
 *     suggestions:     RefinedSuggestion[],  // 개선 제안 목록
 *     evidenceCited:   EvidenceItem[],       // 인용된 근거
 *     clarifications:  string[],             // 보충 필요 항목
 *   }
 *
 *   RefinedSuggestion — {
 *     type:      "bullet" | "summary" | "skill",
 *     content:   string,
 *     evidence:  string[],                   // 근거 출처 텍스트
 *     company?:  string,                     // 경력 항목 대상 (experience 일 때)
 *   }
 *
 * ─── 환경변수 ─────────────────────────────────────────────────────────────────
 *
 *   OPENAI_API_KEY           — 필수
 *   WORK_LOG_OPENAI_URL      — 기본: https://api.openai.com/v1/responses
 *   WORK_LOG_OPENAI_MODEL    — 기본: gpt-5.4-mini
 *   WORK_LOG_DISABLE_OPENAI  — "1" 설정 시 비활성화
 */

import {
  generateResumeDraft,
  loadWorkLogs,
  aggregateSignals,
} from "./resumeDraftGeneration.mjs";

import {
  searchCommits,
  searchSlack,
  searchSessions,
} from "./resumeChatSearch.mjs";

import { collectSlackContexts } from "./slack.mjs";

// ─── Constants ───────────────────────────────────────────────────────────────

const OPENAI_URL =
  process.env.WORK_LOG_OPENAI_URL || "https://api.openai.com/v1/responses";
const OPENAI_MODEL = process.env.WORK_LOG_OPENAI_MODEL || "gpt-5.4-mini";

/** 소스별 최대 근거 수 */
const MAX_EVIDENCE_PER_SOURCE = 15;

/** 초안 생성에 사용할 최대 날짜 수 */
const MAX_DRAFT_DATES = 90;

/** 섹션 정제 LLM 호출 최대 토큰 */
const REFINEMENT_MAX_TOKENS = 2000;

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * 업무 로그 데이터 소스에서 근거를 수집하고 초안을 생성한다.
 *
 * 전체 파이프라인을 실행하여 DraftContext 를 반환한다:
 *   1. 업무 로그 로딩 + 시그널 집계
 *   2. 소스별 근거 풀 구축 (커밋/슬랙/세션 병렬 검색)
 *   3. LLM 초안 생성 (강점 후보 + 경력별 주요 경험)
 *
 * @param {Object} options
 * @param {string}  [options.fromDate]       시작일 (YYYY-MM-DD, 기본: 90일 전)
 * @param {string}  [options.toDate]         종료일 (YYYY-MM-DD, 기본: 오늘)
 * @param {object}  [options.existingResume] 기존 이력서 문서 (있으면 컨텍스트로 사용)
 * @param {object}  [options.currentWorkLog] 현재 배치의 업무 로그 (아직 파일로 저장되지 않은 당일 데이터)
 * @param {boolean} [options.skipLLM=false]  LLM 호출 생략 (근거 수집만)
 * @param {function} [options.onProgress]    진행 상황 콜백 — 백그라운드 실행 시 상태 추적에 사용
 *   @param {Object} progress               진행 상황 메타데이터
 *   @param {string} [progress.stage]        파이프라인 단계 (e.g. "loading_work_logs", "aggregating", "calling_llm")
 *   @param {number} [progress.datesLoaded]  로딩된 업무 로그 날짜 수
 *   @param {number} [progress.commitCount]  커밋 수
 *   @param {number} [progress.slackCount]   슬랙 메시지 수
 *   @param {number} [progress.sessionCount] 세션 수
 * @returns {Promise<DraftContext>}
 */
export async function buildChatDraftContext({
  fromDate,
  toDate,
  existingResume,
  currentWorkLog,
  skipLLM = false,
  onProgress,
} = {}) {
  /** 진행 상황 보고 헬퍼 — onProgress가 없으면 no-op */
  const _report = (progress) => {
    if (typeof onProgress === "function") {
      try { onProgress(progress); } catch { /* 콜백 에러가 파이프라인을 중단시키면 안 됨 */ }
    }
  };

  // ── Step 1: 업무 로그 로딩 ─────────────────────────────────────────────────
  _report({ stage: "loading_work_logs" });
  const workLogs = await loadWorkLogs({ fromDate, toDate });

  // 현재 배치의 업무 로그가 전달되었고, 아직 로딩된 목록에 없으면 추가한다.
  // 배치 실행 중에는 당일 파일이 아직 디스크에 기록되지 않았을 수 있으므로
  // 명시적으로 주입하여 최신 데이터가 초안에 반영되도록 한다.
  if (currentWorkLog && currentWorkLog.date) {
    const alreadyLoaded = workLogs.some((wl) => wl.date === currentWorkLog.date);
    if (!alreadyLoaded) {
      workLogs.unshift(currentWorkLog); // 최신 데이터를 앞에 추가
    }
  }

  _report({ stage: "loading_work_logs", datesLoaded: workLogs.length });

  if (workLogs.length === 0) {
    return {
      draft: null,
      evidencePool: [],
      sourceBreakdown: { commits: 0, slack: 0, sessions: 0, totalDates: 0 },
      dataGaps: ["분석할 업무 로그 데이터가 없습니다. 먼저 일일 배치를 실행해 주세요."],
    };
  }

  // ── Step 2: 시그널 집계 + 소스별 근거 풀 구축 ───────────────────────────────
  _report({ stage: "aggregating_signals", datesLoaded: workLogs.length });
  const aggregated = aggregateSignals(workLogs);

  _report({
    stage: "collecting_evidence",
    datesLoaded: workLogs.length,
    commitCount: aggregated.commitCount,
    slackCount: aggregated.slackCount,
    sessionCount: aggregated.sessionCount,
  });
  const workLogEvidence = await collectEvidenceFromWorkLogs(workLogs, aggregated);

  // ── Step 2b: 직접 Slack API 호출로 근거 보강 ────────────────────────────────
  // 업무 로그에는 간접 참조만 남아있으므로, 최근 날짜의 실제 Slack 메시지를
  // 직접 수집하여 근거 풀을 강화한다. 최대 7일치만 호출하여 API 부하를 제한한다.
  _report({ stage: "collecting_slack_evidence" });
  const slackEvidence = await collectDirectSlackEvidence(workLogs);
  const evidencePool = deduplicateEvidence([...workLogEvidence, ...slackEvidence]);
  const sourceBreakdown = computeSourceBreakdown(evidencePool, workLogs);

  // ── Step 3: LLM 초안 생성 ─────────────────────────────────────────────────
  let draft = null;
  if (!skipLLM) {
    _report({
      stage: "calling_llm",
      datesLoaded: workLogs.length,
      commitCount: aggregated.commitCount,
      slackCount: aggregated.slackCount,
      sessionCount: aggregated.sessionCount,
    });
    try {
      draft = await generateResumeDraft({ fromDate, toDate, existingResume });
    } catch (err) {
      // LLM 실패 시에도 근거 풀은 반환 — 사용자가 수동으로 작업 가능
      console.warn("[resumeChatDraftService] Draft generation failed:", err.message);
      return {
        draft: null,
        evidencePool,
        sourceBreakdown,
        dataGaps: [`초안 생성에 실패했습니다: ${err.message}`],
      };
    }
  }

  _report({ stage: "done" });

  return {
    draft,
    evidencePool,
    sourceBreakdown,
    dataGaps: draft?.dataGaps ?? [],
  };
}

/**
 * 특정 섹션에 대해 대화 맥락과 근거를 기반으로 개선 제안을 생성한다.
 *
 * 근거 없이 허구를 생성하지 않으며, 데이터가 부족한 경우
 * clarifications 배열에 보충 질문을 반환한다.
 *
 * @param {Object} options
 * @param {string}   options.section          대상 섹션 ('experience'|'skills'|'summary'|'projects')
 * @param {string}   options.userMessage      사용자 대화 메시지
 * @param {object}   [options.draft]          기존 초안 (DraftContext.draft)
 * @param {object[]} [options.evidencePool]   근거 풀 (DraftContext.evidencePool)
 * @param {object}   [options.existingResume] 현재 이력서
 * @param {{ role: string, content: string }[]} [options.history] 대화 히스토리
 * @returns {Promise<SectionRefinement>}
 */
export async function refineSectionWithChat({
  section,
  userMessage,
  draft,
  evidencePool = [],
  existingResume,
  history = [],
} = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }
  if (process.env.WORK_LOG_DISABLE_OPENAI === "1") {
    throw new Error("OpenAI integration is disabled (WORK_LOG_DISABLE_OPENAI=1)");
  }

  // ── 관련 근거 필터링 ─────────────────────────────────────────────────────
  const relevantEvidence = filterEvidenceForSection(section, evidencePool, userMessage);

  // ── 근거 부족 시 보충 질문 반환 ──────────────────────────────────────────
  if (relevantEvidence.length === 0 && !hasDraftContentForSection(draft, section)) {
    return {
      section,
      suggestions: [],
      evidenceCited: [],
      clarifications: buildClarificationQuestions(section, userMessage),
    };
  }

  // ── LLM 호출로 섹션별 제안 생성 ──────────────────────────────────────────
  const payload = buildRefinementPayload({
    section,
    userMessage,
    relevantEvidence,
    draft,
    existingResume,
    history,
  });

  const response = await fetch(OPENAI_URL, {
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
      `Section refinement LLM call failed: ${response.status} ${errorText.slice(0, 400)}`
    );
  }

  const data = await response.json();
  const rawText = data.output_text || extractOutputText(data);
  if (!rawText) {
    throw new Error("Section refinement LLM call returned empty output");
  }

  const parsed = JSON.parse(rawText);
  return normalizeRefinementResult(parsed, section, relevantEvidence);
}

/**
 * 키워드를 기반으로 모든 데이터 소스에서 근거를 검색한다.
 *
 * resumeChatSearch 의 개별 어댑터를 병렬로 호출하고
 * 결과를 단일 EvidenceItem[] 으로 통합한다.
 *
 * @param {string[]} keywords  검색 키워드
 * @param {Object}   [options]
 * @param {string}   [options.fromDate]  시작일
 * @param {string}   [options.toDate]    종료일
 * @param {number}   [options.maxResults] 소스당 최대 결과 수
 * @returns {Promise<EvidenceItem[]>}
 */
export async function searchEvidenceByKeywords(keywords, {
  fromDate,
  toDate,
  maxResults = MAX_EVIDENCE_PER_SOURCE,
} = {}) {
  if (!keywords || keywords.length === 0) return [];

  const query = {
    keywords,
    dateRange: fromDate || toDate ? { from: fromDate, to: toDate } : undefined,
    maxResults,
  };

  const [commits, slack, sessions] = await Promise.all([
    searchCommits(query).catch(() => []),
    searchSlack(query).catch(() => []),
    searchSessions(query).catch(() => []),
  ]);

  return [
    ...commits.map(normalizeToEvidence),
    ...slack.map(normalizeToEvidence),
    ...sessions.map(normalizeToEvidence),
  ];
}

/**
 * 초안에서 특정 섹션에 해당하는 콘텐츠를 추출한다.
 *
 * @param {object|null} draft  ResumeDraft
 * @param {string}      section  대상 섹션
 * @returns {{ strengths: object[], experiences: object[], summary: string }}
 */
export function extractDraftContentForSection(draft, section) {
  if (!draft) return { strengths: [], experiences: [], summary: "" };

  const strengths = draft.strengthCandidates ?? [];
  const experiences = draft.experienceSummaries ?? [];
  const summary = draft.suggestedSummary ?? "";

  switch (section) {
    case "experience":
      return { strengths: [], experiences, summary: "" };
    case "summary":
      return { strengths, experiences: [], summary };
    case "skills": {
      // 경험 요약에서 스킬 정보 추출
      const skillExperiences = experiences.map((e) => ({
        ...e,
        highlights: [],
        suggestedBullets: [],
      }));
      return { strengths: [], experiences: skillExperiences, summary: "" };
    }
    case "strengths":
      return { strengths, experiences: [], summary: "" };
    case "projects": {
      // 프로젝트 관련 경험 필터링
      const projExperiences = experiences.filter(
        (e) => e.company && !e.company.includes("(주)")
      );
      return { strengths: [], experiences: projExperiences, summary: "" };
    }
    default:
      return { strengths, experiences, summary };
  }
}

// ─── Internal: Evidence collection ───────────────────────────────────────────

/**
 * 업무 로그에서 키워드 없이 직접 근거를 수집한다.
 *
 * 각 업무 로그의 주요 필드(businessOutcomes, storyThreads, commitAnalysis,
 * aiReview 등)를 EvidenceItem 으로 변환한다.
 *
 * @param {object[]}  workLogs    일일 업무 로그 배열
 * @param {object}    aggregated  aggregateSignals 결과
 * @returns {Promise<EvidenceItem[]>}
 */
async function collectEvidenceFromWorkLogs(workLogs, aggregated) {
  const evidence = [];

  for (const wl of workLogs) {
    const date = wl.date ?? "unknown";
    const highlights = wl.highlights ?? {};
    const counts = wl.counts ?? {};

    // ── 커밋 근거 ───────────────────────────────────────────────────────────
    for (const thread of (highlights.storyThreads ?? []).slice(0, 5)) {
      const parts = [thread.outcome, thread.keyChange, thread.why, thread.decision]
        .filter(Boolean);
      if (parts.length > 0) {
        evidence.push({
          source: "commits",
          date,
          text: parts.join(" — "),
          score: 1.0,
          repo: thread.repo ?? "",
        });
      }
    }

    for (const line of (highlights.commitAnalysis ?? []).slice(0, 3)) {
      evidence.push({
        source: "commits",
        date,
        text: line,
        score: 0.8,
      });
    }

    for (const line of (highlights.businessOutcomes ?? []).slice(0, 3)) {
      evidence.push({
        source: "commits",
        date,
        text: line,
        score: 0.9,
      });
    }

    // ── 세션 메모리 근거 ─────────────────────────────────────────────────────
    for (const line of (highlights.aiReview ?? []).slice(0, 3)) {
      evidence.push({
        source: "sessions",
        date,
        text: line,
        score: 0.7,
      });
    }

    for (const signal of (highlights.workingStyleSignals ?? []).slice(0, 2)) {
      evidence.push({
        source: "sessions",
        date,
        text: signal,
        score: 0.6,
      });
    }

    // ── 슬랙 근거 (업무 로그에 포함된 간접 참조) ───────────────────────────
    // 슬랙 메시지 자체는 업무 로그에 저장되지 않으나,
    // impact 와 accomplishments 에 슬랙 기반 업무 내용이 반영됨
    if ((counts.slackContexts ?? 0) > 0) {
      for (const line of (highlights.impact ?? []).slice(0, 2)) {
        evidence.push({
          source: "slack",
          date,
          text: line,
          score: 0.7,
        });
      }
    }

    // ── 커밋 원문 근거 (projects[].commits[].subject) ──────────────────────
    // 요약(storyThreads/commitAnalysis)에 반영되지 않은 개별 커밋 메시지를
    // 추가로 수집한다. 특히 feat/fix 접두어가 있는 커밋은 구체적인 작업 근거가 된다.
    const projects = wl.projects ?? [];
    for (const project of projects) {
      const repo = project.repo ?? "";
      for (const commit of (project.commits ?? []).slice(0, 6)) {
        const subject = commit.subject ?? "";
        if (!subject || subject.length < 10) continue;
        evidence.push({
          source: "commits",
          date,
          text: `[${repo}] ${subject}`,
          score: 0.6,
          repo,
        });
      }
    }

    // ── 커밋 하이라이트 근거 ───────────────────────────────────────────────
    // highlights.commitHighlights 에는 대표 커밋이 "repo: subject" 형태로 정리됨
    for (const line of (highlights.commitHighlights ?? []).slice(0, 4)) {
      evidence.push({
        source: "commits",
        date,
        text: line,
        score: 0.7,
      });
    }

    // ── 세션 메모리 원문 근거 (aiSessions) ──────────────────────────────────
    // 요약(aiReview)에 반영되지 않은 원시 세션 스니펫을 수집한다.
    const aiSessions = wl.aiSessions ?? {};
    for (const sessionType of ["codex", "claude"]) {
      for (const session of (aiSessions[sessionType] ?? []).slice(0, 3)) {
        if (session.summary) {
          evidence.push({
            source: "sessions",
            date,
            text: session.summary,
            score: 0.65,
          });
        }
        for (const snippet of (session.snippets ?? []).slice(0, 2)) {
          if (typeof snippet === "string" && snippet.trim().length >= 15) {
            evidence.push({
              source: "sessions",
              date,
              text: snippet.trim(),
              score: 0.5,
            });
          }
        }
      }
    }
  }

  // 중복 제거 + 점수순 정렬
  return deduplicateEvidence(evidence);
}

/**
 * 직접 Slack API를 호출하여 최근 날짜의 메시지를 근거로 수집한다.
 *
 * 업무 로그에는 Slack 메시지의 간접 참조(impact/accomplishments)만 남아있으므로,
 * 원본 메시지를 직접 수집하면 더 풍부한 근거를 확보할 수 있다.
 *
 * API 부하를 제한하기 위해 최근 7일치만 호출하며,
 * Slack 토큰이 없거나 API 호출이 실패하면 빈 배열을 반환한다 (비파괴적).
 *
 * @param {object[]} workLogs  업무 로그 배열 (날짜 추출용)
 * @returns {Promise<EvidenceItem[]>}
 */
async function collectDirectSlackEvidence(workLogs) {
  // Slack 토큰이 없으면 즉시 반환 (환경에 따라 선택적)
  const token = process.env.SLACK_TOKEN || process.env.SLACK_USER_TOKEN || "";
  const channelIds = process.env.SLACK_CHANNEL_IDS || process.env.WORK_LOG_SLACK_CHANNEL_IDS || "";
  if (!token || !channelIds) return [];

  // 최근 7일의 날짜만 추출 (API 부하 제한)
  const MAX_SLACK_DAYS = 7;
  const recentDates = workLogs
    .map((wl) => wl.date)
    .filter(Boolean)
    .slice(0, MAX_SLACK_DAYS);

  if (recentDates.length === 0) return [];

  const evidence = [];

  for (const date of recentDates) {
    try {
      const contexts = await collectSlackContexts(date);
      for (const ctx of contexts) {
        if (!ctx.text || ctx.text.length < 10) continue;

        // 메시지 본문을 근거로 추가
        evidence.push({
          source: "slack",
          date,
          text: ctx.text,
          score: 0.75,
        });

        // 스레드 맥락이 있으면 추가 근거로 포함
        for (const ctxMsg of (ctx.context ?? []).slice(0, 2)) {
          if (ctxMsg && ctxMsg.length >= 10) {
            evidence.push({
              source: "slack",
              date,
              text: `[thread] ${ctxMsg}`,
              score: 0.55,
            });
          }
        }
      }
    } catch {
      // Slack 수집 실패는 비파괴적 — 로그만 남기고 계속 진행
      console.warn(`[resumeChatDraftService] Direct Slack collection failed for ${date} (non-fatal)`);
    }
  }

  return evidence;
}

/**
 * 소스별 통계를 계산한다.
 *
 * @param {EvidenceItem[]}  evidencePool
 * @param {object[]}        workLogs
 * @returns {SourceBreakdown}
 */
function computeSourceBreakdown(evidencePool, workLogs) {
  const commits = evidencePool.filter((e) => e.source === "commits").length;
  const slack = evidencePool.filter((e) => e.source === "slack").length;
  const sessions = evidencePool.filter((e) => e.source === "sessions").length;

  return {
    commits,
    slack,
    sessions,
    totalDates: workLogs.length,
  };
}

// ─── Internal: Evidence filtering ────────────────────────────────────────────

/**
 * 특정 섹션과 사용자 메시지에 관련된 근거를 필터링한다.
 *
 * @param {string}   section
 * @param {object[]} evidencePool
 * @param {string}   userMessage
 * @returns {object[]}
 */
function filterEvidenceForSection(section, evidencePool, userMessage) {
  if (!evidencePool || evidencePool.length === 0) return [];

  // 사용자 메시지에서 키워드 추출 (간단한 토큰화)
  const keywords = extractKeywordsFromMessage(userMessage);

  // 섹션별 소스 우선순위
  const sourceWeights = {
    experience: { commits: 1.0, sessions: 0.7, slack: 0.5 },
    skills:     { commits: 0.8, sessions: 1.0, slack: 0.3 },
    summary:    { commits: 0.8, sessions: 0.8, slack: 0.6 },
    strengths:  { sessions: 1.0, commits: 0.7, slack: 0.5 },
    projects:   { commits: 1.0, sessions: 0.8, slack: 0.3 },
  };

  const weights = sourceWeights[section] ?? { commits: 0.7, sessions: 0.7, slack: 0.5 };

  return evidencePool
    .map((item) => {
      const sourceWeight = weights[item.source] ?? 0.5;
      const keywordBoost = keywords.length > 0
        ? computeKeywordOverlap(item.text, keywords)
        : 0;
      return {
        ...item,
        _relevanceScore: item.score * sourceWeight + keywordBoost * 0.3,
      };
    })
    .filter((item) => item._relevanceScore > 0.1)
    .sort((a, b) => b._relevanceScore - a._relevanceScore)
    .slice(0, MAX_EVIDENCE_PER_SOURCE);
}

/**
 * 초안에 특정 섹션에 해당하는 콘텐츠가 있는지 확인한다.
 *
 * @param {object|null} draft
 * @param {string}      section
 * @returns {boolean}
 */
function hasDraftContentForSection(draft, section) {
  if (!draft) return false;

  switch (section) {
    case "experience":
      return (draft.experienceSummaries ?? []).length > 0;
    case "summary":
      return !!draft.suggestedSummary;
    case "skills":
      return (draft.experienceSummaries ?? []).some(
        (e) => (e.skills ?? []).length > 0
      );
    case "strengths":
      return (draft.strengthCandidates ?? []).length > 0;
    case "projects":
      return (draft.experienceSummaries ?? []).length > 0;
    default:
      return false;
  }
}

/**
 * 근거 부족 시 섹션별 보충 질문을 생성한다.
 *
 * @param {string} section
 * @param {string} userMessage
 * @returns {string[]}
 */
function buildClarificationQuestions(section, userMessage) {
  const sectionQuestions = {
    experience: [
      "어떤 회사/프로젝트에서의 경험을 다듬고 싶으신가요?",
      "해당 업무에서 달성한 구체적인 성과나 수치가 있나요?",
      "팀 규모나 본인의 역할 범위를 알려주시면 더 정확한 어필 포인트를 작성할 수 있습니다.",
    ],
    skills: [
      "어떤 기술 영역을 중점적으로 부각하고 싶으신가요?",
      "최근에 새로 익힌 기술이나 도구가 있나요?",
    ],
    summary: [
      "현재 어필하고 싶은 직무 방향이 있으신가요?",
      "본인의 차별화 포인트라고 생각하는 점이 있으신가요?",
    ],
    strengths: [
      "업무에서 가장 자신 있는 역할이나 상황은 무엇인가요?",
      "동료들로부터 자주 듣는 피드백이 있나요?",
    ],
    projects: [
      "어떤 프로젝트를 부각하고 싶으신가요?",
      "해당 프로젝트에서 본인이 기여한 핵심 부분은 무엇인가요?",
    ],
  };

  return sectionQuestions[section] ?? [
    "어떤 내용을 이력서에 반영하고 싶으신가요?",
    "구체적인 성과나 경험을 알려주시면 근거 기반으로 작성해드리겠습니다.",
  ];
}

// ─── Internal: LLM payload for section refinement ────────────────────────────

/**
 * 섹션 정제 LLM 호출 페이로드를 생성한다.
 */
function buildRefinementPayload({
  section,
  userMessage,
  relevantEvidence,
  draft,
  existingResume,
  history,
}) {
  const lang = existingResume?.meta?.language ?? "ko";
  const systemPrompt = buildRefinementSystemPrompt(section, lang);
  const userContent = buildRefinementUserMessage({
    section,
    userMessage,
    relevantEvidence,
    draft,
    existingResume,
    history,
    lang,
  });

  return {
    model: OPENAI_MODEL,
    reasoning: { effort: "low" },
    text: {
      format: {
        type: "json_schema",
        name: "section_refinement",
        strict: true,
        schema: REFINEMENT_OUTPUT_SCHEMA,
      },
    },
    max_output_tokens: REFINEMENT_MAX_TOKENS,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: systemPrompt }],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: userContent }],
      },
    ],
  };
}

function buildRefinementSystemPrompt(section, lang) {
  const isKorean = lang === "ko";
  return `\
You refine a specific resume section based on evidence from work logs.

━━━ YOUR ROLE ━━━
You receive:
1. A target resume section to refine
2. Evidence from work logs (commits, Slack, AI sessions) that supports claims
3. The user's refinement request via chat
4. Optionally, existing draft suggestions and current resume content

Your job is to generate EVIDENCE-BACKED suggestions for the target section.

━━━ STRICT RULES ━━━
• ONLY generate content supported by the provided evidence.
• Each suggestion MUST cite specific evidence snippets.
• If evidence is insufficient, list clarification questions instead of inventing content.
• ${isKorean ? "Output all text in Korean." : "Output all text in English."}
• Bullets must be achievement-oriented: [action verb] + [what] + [quantified result/impact].
• Do NOT repeat content already in the existing resume.
• Prefer concrete metrics when evidence provides them.

━━━ SECTION-SPECIFIC GUIDANCE ━━━
${getSectionGuidance(section, isKorean)}`;
}

function getSectionGuidance(section, isKorean) {
  const guides = {
    experience: `\
For experience bullets:
• Focus on measurable outcomes (%, time saved, reliability improvements)
• Structure: [Action] + [Technical detail] + [Business impact]
• Assign each bullet to the correct company/role based on evidence repo/context`,
    skills: `\
For skills:
• Only list skills demonstrated in the evidence (not assumed)
• Categorize into technical, tools, languages
• Order by evidence frequency (most demonstrated first)`,
    summary: `\
For professional summary:
• Synthesize the top 2-3 behavioral patterns from evidence
• Keep to 2-3 sentences maximum
• Must reflect actual work patterns, not aspirational claims`,
    strengths: `\
For behavioral strengths:
• Each strength must appear across ≥2 distinct dates in evidence
• Describe patterns, not technologies
• Include concrete examples from evidence as backing`,
    projects: `\
For projects:
• Focus on impact and technical complexity
• Include tech stack only when clearly evidenced
• Bullet format: [Built/Designed/Implemented] + [what] + [outcome]`,
  };
  return guides[section] ?? guides.experience;
}

function buildRefinementUserMessage({
  section,
  userMessage,
  relevantEvidence,
  draft,
  existingResume,
  history,
  lang,
}) {
  const parts = [];

  // 사용자 요청
  parts.push(`# 사용자 요청\n${userMessage}`);

  // 대화 히스토리 (최근 4턴만)
  if (history.length > 0) {
    const recentHistory = history.slice(-8); // 최근 4턴 (user+assistant 각 1개)
    parts.push("\n# 대화 맥락");
    for (const msg of recentHistory) {
      parts.push(`[${msg.role}] ${(msg.content ?? "").slice(0, 300)}`);
    }
  }

  // 근거 데이터
  if (relevantEvidence.length > 0) {
    parts.push(`\n# 근거 데이터 (${relevantEvidence.length}건)`);
    for (const ev of relevantEvidence.slice(0, 10)) {
      const srcLabel = { commits: "커밋", slack: "슬랙", sessions: "세션" }[ev.source] ?? ev.source;
      const repoInfo = ev.repo ? ` [${ev.repo}]` : "";
      parts.push(`- [${srcLabel}${repoInfo} ${ev.date}] ${ev.text}`);
    }
  }

  // 초안에서 해당 섹션 콘텐츠
  const draftContent = extractDraftContentForSection(draft, section);
  if (draftContent.strengths.length > 0) {
    parts.push("\n# 초안 강점 후보");
    for (const s of draftContent.strengths.slice(0, 4)) {
      parts.push(`- ${s.label}: ${s.description}`);
    }
  }
  if (draftContent.experiences.length > 0) {
    parts.push("\n# 초안 경력 요약");
    for (const e of draftContent.experiences.slice(0, 4)) {
      const bullets = (e.suggestedBullets ?? []).slice(0, 3).join("; ");
      parts.push(`- ${e.company}: ${bullets || e.highlights?.join("; ") || ""}`);
    }
  }
  if (draftContent.summary) {
    parts.push(`\n# 초안 자기소개\n${draftContent.summary}`);
  }

  // 기존 이력서의 해당 섹션
  if (existingResume) {
    const currentContent = extractCurrentSectionContent(existingResume, section);
    if (currentContent) {
      parts.push(`\n# 현재 이력서 (${section} 섹션)\n${currentContent}`);
    }
  }

  parts.push(`\n위 근거를 바탕으로 ${section} 섹션의 개선 제안을 생성해주세요.`);
  return parts.join("\n");
}

/**
 * 현재 이력서에서 특정 섹션의 텍스트를 추출한다.
 */
function extractCurrentSectionContent(resume, section) {
  switch (section) {
    case "summary":
      return resume.summary ?? "";
    case "experience":
      return (resume.experience ?? [])
        .map((e) => {
          const bullets = (e.bullets ?? []).join("\n  - ");
          return `${e.company} (${e.title ?? ""}):\n  - ${bullets}`;
        })
        .join("\n");
    case "skills": {
      const s = resume.skills ?? {};
      const parts = [];
      if (s.technical?.length) parts.push(`기술: ${s.technical.join(", ")}`);
      if (s.languages?.length) parts.push(`언어: ${s.languages.join(", ")}`);
      if (s.tools?.length) parts.push(`도구: ${s.tools.join(", ")}`);
      return parts.join("\n");
    }
    case "projects":
      return (resume.projects ?? [])
        .map((p) => {
          const bullets = (p.bullets ?? []).join("\n  - ");
          return `${p.name}: ${p.description ?? ""}\n  - ${bullets}`;
        })
        .join("\n");
    default:
      return null;
  }
}

// ─── Output schemas ──────────────────────────────────────────────────────────

const REFINEMENT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["suggestions", "clarifications"],
  properties: {
    suggestions: {
      type: "array",
      minItems: 0,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "content", "evidence"],
        properties: {
          type: {
            type: "string",
            enum: ["bullet", "summary", "skill"],
          },
          content: { type: "string" },
          evidence: {
            type: "array",
            items: { type: "string" },
            minItems: 0,
            maxItems: 3,
          },
          company: { type: "string" },
        },
      },
    },
    clarifications: {
      type: "array",
      items: { type: "string" },
      minItems: 0,
      maxItems: 4,
    },
  },
};

// ─── Normalization ───────────────────────────────────────────────────────────

/**
 * LLM 응답을 SectionRefinement 형태로 정규화한다.
 */
function normalizeRefinementResult(parsed, section, relevantEvidence) {
  const suggestions = (parsed.suggestions ?? [])
    .filter((s) => s && typeof s.content === "string" && s.content.trim())
    .map((s) => ({
      type: s.type || "bullet",
      content: String(s.content).trim(),
      evidence: Array.isArray(s.evidence)
        ? s.evidence.filter((e) => typeof e === "string" && e.trim()).map((e) => e.trim())
        : [],
      company: typeof s.company === "string" && s.company.trim() ? s.company.trim() : undefined,
    }));

  const clarifications = (parsed.clarifications ?? [])
    .filter((c) => typeof c === "string" && c.trim())
    .map((c) => c.trim());

  return {
    section,
    suggestions,
    evidenceCited: relevantEvidence.slice(0, 5),
    clarifications,
  };
}

/**
 * 검색 결과를 EvidenceItem 형태로 정규화한다.
 */
function normalizeToEvidence(searchResult) {
  return {
    source: searchResult.source,
    date: searchResult.date ?? "",
    text: searchResult.text ?? "",
    score: searchResult.score ?? 0,
    repo: searchResult.repo ?? undefined,
  };
}

// ─── Utilities ───────────────────────────────────────────────────────────────

/**
 * 사용자 메시지에서 간단하게 키워드를 추출한다.
 *
 * @param {string} message
 * @returns {string[]}
 */
function extractKeywordsFromMessage(message) {
  if (!message || typeof message !== "string") return [];

  // 조사·접속사·일반 불용어 제거 후 2글자 이상 토큰만 추출
  const stopWords = new Set([
    "을", "를", "이", "가", "은", "는", "에", "의", "로", "으로",
    "에서", "에게", "와", "과", "도", "부터", "까지", "만", "해줘",
    "해주세요", "해줄", "알려", "보여", "싶어", "좋겠", "어떻게",
    "the", "a", "an", "is", "are", "was", "were", "in", "on", "at",
    "to", "for", "of", "with", "and", "or", "but", "not",
  ]);

  return message
    .replace(/[.,?!;:'"()[\]{}<>]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !stopWords.has(w.toLowerCase()))
    .map((w) => w.toLowerCase());
}

/**
 * 텍스트와 키워드 간 겹침 비율을 계산한다.
 *
 * @param {string}   text
 * @param {string[]} keywords
 * @returns {number}  0.0–1.0
 */
function computeKeywordOverlap(text, keywords) {
  if (!text || keywords.length === 0) return 0;
  const lowerText = text.toLowerCase();
  const matched = keywords.filter((kw) => lowerText.includes(kw));
  return matched.length / keywords.length;
}

/**
 * 중복 근거를 제거하고 점수순으로 정렬한다.
 *
 * @param {EvidenceItem[]} evidence
 * @returns {EvidenceItem[]}
 */
function deduplicateEvidence(evidence) {
  const seen = new Set();
  const deduped = [];

  for (const item of evidence) {
    const key = `${item.source}::${item.text.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }

  deduped.sort((a, b) => b.score - a.score);
  return deduped;
}

/**
 * OpenAI Responses API 의 output 에서 텍스트를 추출한다.
 */
function extractOutputText(data) {
  if (data?.output_text) return data.output_text;
  if (Array.isArray(data?.output)) {
    for (const block of data.output) {
      if (block?.type === "message" && Array.isArray(block?.content)) {
        for (const part of block.content) {
          if (part?.type === "output_text" && part?.text) return part.text;
          if (part?.type === "text" && part?.text) return part.text;
        }
      }
    }
  }
  return null;
}
