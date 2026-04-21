export const BATCH_SUMMARY_SCHEMA_VERSION = 1;
export const BATCH_SUMMARY_PREVIEW_LIMIT = 3;

export const CANDIDATE_DISCARD_REASON_CODES = /** @type {const} */ ([
  "too_vague",
  "inaccurate",
  "duplicate",
  "wrong_focus",
  "tone_off",
  "missing_metric",
]);

const DISCARD_REASON_SET = new Set(CANDIDATE_DISCARD_REASON_CODES);

const FOLLOW_UP_ACTIONS = Object.freeze([
  { kind: "open_chat", label: "채팅에서 수치 정리하기", href: "/resume/chat" },
  { kind: "open_resume", label: "이력서 편집 열기", href: "/resume" },
]);

/**
 * Build a user-facing batch summary document from the daily batch result.
 *
 * @param {object} params
 * @param {string} params.date
 * @param {object} params.summary
 * @param {object|null|undefined} params.candidateHook
 * @param {{ suggestions?: object[] }|null|undefined} [params.suggestionsDoc]
 * @param {{ status?: string, triggeredBy?: string|null }|null|undefined} [params.draftState]
 * @returns {object}
 */
export function buildBatchSummary({
  date,
  summary,
  candidateHook,
  suggestionsDoc,
  draftState,
}) {
  const candidatePreview = buildCandidatePreview(suggestionsDoc, date);
  const candidateGeneration = normalizeCandidateGeneration(candidateHook);
  const draft = normalizeDraftState(candidateHook, draftState);

  return {
    schemaVersion: BATCH_SUMMARY_SCHEMA_VERSION,
    date,
    generatedAt: new Date().toISOString(),
    sourceCounts: {
      gitCommits: Number(summary?.counts?.gitCommits ?? 0),
      slackContexts: Number(summary?.counts?.slackContexts ?? 0),
      sessions:
        Number(summary?.counts?.codexSessions ?? 0) +
        Number(summary?.counts?.claudeSessions ?? 0),
      shellCommands: Number(summary?.counts?.shellCommands ?? 0),
    },
    candidateGeneration,
    draft,
    candidatePreview,
    emptyState: buildEmptyState(candidateGeneration, draft),
  };
}

/**
 * Merge a live draft-generation state into a stored batch summary.
 *
 * @param {object|null} summary
 * @param {{ status?: string, triggeredBy?: string|null }|null|undefined} draftState
 * @returns {object|null}
 */
export function withLiveDraftState(summary, draftState) {
  if (!summary) return null;
  return {
    ...summary,
    draft: normalizeDraftState(
      { draftGenerationTriggered: summary?.draft?.triggered === true },
      draftState
    ),
  };
}

/**
 * Validate a candidate discard reason code.
 *
 * @param {unknown} reasonCode
 * @returns {boolean}
 */
export function isValidCandidateDiscardReason(reasonCode) {
  return typeof reasonCode === "string" && DISCARD_REASON_SET.has(reasonCode);
}

/**
 * Build a follow-up prompt when a candidate is discarded due to missing metrics.
 *
 * @param {{ candidate?: object|null, reasonCode?: string|null, note?: string|null|undefined }} params
 * @returns {object|null}
 */
export function buildCandidateFollowUp({ candidate, reasonCode, note } = {}) {
  if (reasonCode !== "missing_metric") {
    return null;
  }

  return buildMissingMetricFollowUp({ candidate, note });
}

/**
 * @param {{ candidate?: object|null, note?: string|null|undefined }} params
 * @returns {object}
 */
export function buildMissingMetricFollowUp({ candidate, note } = {}) {
  const contextLabel = formatCandidateContext(candidate);
  const trimmedNote = typeof note === "string" && note.trim() ? note.trim() : null;

  return {
    kind: "missing_metric",
    title: "수치 근거만 보강하면 다시 강한 후보로 만들 수 있어요.",
    body: `${contextLabel} 관련 후보를 "수치가 없음"으로 넘겼습니다. 아래 질문에 답해두면 다음 배치나 채팅에서 더 설득력 있는 문장으로 다시 다듬기 쉽습니다.`,
    note: trimmedNote,
    questions: buildMissingMetricQuestions(candidate),
    actions: FOLLOW_UP_ACTIONS.map((action) => ({ ...action })),
    contextLabel,
  };
}

/**
 * @param {{ suggestions?: object[] }|null|undefined} suggestionsDoc
 * @param {string} date
 * @returns {object[]}
 */
export function buildCandidatePreview(suggestionsDoc, date) {
  const suggestions = Array.isArray(suggestionsDoc?.suggestions)
    ? suggestionsDoc.suggestions
    : [];

  return suggestions
    .filter((item) => item?.status === "pending" && item?.logDate === date)
    .slice(0, BATCH_SUMMARY_PREVIEW_LIMIT)
    .map((item) => ({
      id: item.id,
      section: item.section ?? null,
      action: item.action ?? null,
      description: item.description ?? "",
      status: item.status,
      source: item.source ?? null,
      logDate: item.logDate ?? null,
    }));
}

/**
 * @param {object|null|undefined} candidateHook
 * @returns {object}
 */
export function normalizeCandidateGeneration(candidateHook) {
  const generated = Number(candidateHook?.generated ?? 0);
  const superseded = Number(candidateHook?.superseded ?? 0);
  const deltaRatio =
    typeof candidateHook?.deltaRatio === "number" ? candidateHook.deltaRatio : null;
  const deltaChangedCount =
    typeof candidateHook?.deltaChangedCount === "number"
      ? candidateHook.deltaChangedCount
      : null;
  const deltaTotalCount =
    typeof candidateHook?.deltaTotalCount === "number"
      ? candidateHook.deltaTotalCount
      : null;
  const skipReason = candidateHook?.skipReason ?? null;
  const error = candidateHook?.error ?? null;

  let status = "no_changes";
  let message = "이번 배치에서는 새로운 이력서 후보가 감지되지 않았습니다.";

  if (error) {
    status = "error";
    message = error;
  } else if (candidateHook?.skipped) {
    status = "skipped";
    message = skipReasonToMessage(skipReason);
  } else if (candidateHook?.belowThreshold) {
    status = "below_threshold";
    const pct = deltaRatio === null ? null : `${(deltaRatio * 100).toFixed(1)}%`;
    message = pct
      ? `변경 비율 ${pct}가 임계값 3%보다 낮아 이번엔 후보를 만들지 않았습니다.`
      : "변경 비율이 임계값보다 낮아 이번엔 후보를 만들지 않았습니다.";
  } else if (generated > 0) {
    status = "generated";
    message = `새 이력서 후보 ${generated}개를 만들었습니다.`;
  }

  return {
    status,
    generated,
    superseded,
    deltaRatio,
    deltaChangedCount,
    deltaTotalCount,
    skipReason,
    error,
    message,
  };
}

/**
 * @param {object|null|undefined} candidateHook
 * @param {{ status?: string, triggeredBy?: string|null }|null|undefined} draftState
 * @returns {{ status: string, triggered: boolean, triggeredBy: string|null }}
 */
export function normalizeDraftState(candidateHook, draftState) {
  const liveStatus = draftState?.status;

  if (liveStatus === "pending" || liveStatus === "completed" || liveStatus === "failed") {
    return {
      status: liveStatus,
      triggered: true,
      triggeredBy: draftState?.triggeredBy ?? null,
    };
  }

  if (candidateHook?.draftGenerationTriggered) {
    return {
      status: "pending",
      triggered: true,
      triggeredBy: draftState?.triggeredBy ?? "batch",
    };
  }

  return {
    status: "not_started",
    triggered: false,
    triggeredBy: null,
  };
}

/**
 * @param {object} candidateGeneration
 * @param {{ status: string }} draft
 * @returns {object|null}
 */
export function buildEmptyState(candidateGeneration, draft) {
  if (candidateGeneration.status === "generated") return null;

  if (candidateGeneration.status === "below_threshold") {
    return {
      reasonCode: "below_threshold",
      title: "이번엔 새 후보가 없습니다.",
      body: candidateGeneration.message,
    };
  }

  if (candidateGeneration.status === "skipped") {
    return {
      reasonCode: candidateGeneration.skipReason ?? "skipped",
      title: "이번 배치에서는 후보 생성을 건너뛰었습니다.",
      body: candidateGeneration.message,
    };
  }

  if (candidateGeneration.status === "error") {
    return {
      reasonCode: "error",
      title: "후보 생성 중 문제가 생겼습니다.",
      body: candidateGeneration.message,
    };
  }

  if (draft.status === "pending") {
    return {
      reasonCode: "draft_pending",
      title: "후보는 아직 없지만 초안을 만드는 중입니다.",
      body: "잠시 후 이력서 채팅에서 초안과 근거를 확인할 수 있습니다.",
    };
  }

  return {
    reasonCode: "no_changes",
    title: "이번 배치에서는 새 후보가 없습니다.",
    body: candidateGeneration.message,
  };
}

function skipReasonToMessage(skipReason) {
  switch (skipReason) {
    case "no_resume":
      return "기본 이력서가 아직 없어 후보 생성을 건너뛰었습니다.";
    case "openai_disabled":
      return "AI 생성 기능이 비활성화되어 후보 생성을 건너뛰었습니다.";
    case "no_blob_token":
      return "저장소 설정이 없어 후보 결과를 저장하지 못했습니다.";
    default:
      return "이번 배치에서는 후보 생성을 건너뛰었습니다.";
  }
}

function buildMissingMetricQuestions(candidate) {
  const contextLabel = formatCandidateContext(candidate);
  const section = candidate?.section ?? null;

  if (section === "summary") {
    return [
      `${contextLabel}를 대표할 숫자 1~2개는 무엇인가요? 예: 사용자 수, 매출, 처리량, 전환율`,
      `${contextLabel} 전후로 달라진 결과를 퍼센트·시간·비용으로 말하면 어느 정도인가요?`,
      `${contextLabel}에서 내가 직접 책임진 범위는 팀 규모나 프로젝트 범위로 어느 정도였나요?`,
    ];
  }

  if (section === "skills") {
    return [
      `${contextLabel}을 실제로 사용한 기간·빈도·시스템 규모를 숫자로 적어볼 수 있나요?`,
      `${contextLabel}으로 줄인 시간이나 개선한 지표가 있다면 얼마나 달라졌나요?`,
      `${contextLabel}을 적용한 대상이 사용자 수·요청량·데이터 크기 기준으로 어느 정도였나요?`,
    ];
  }

  return [
    `${contextLabel}에서 가장 중요한 결과를 숫자로 말하면 무엇인가요? 예: %, 시간, 비용, 건수`,
    `${contextLabel} 전후 비교가 가능하다면 어떤 지표가 얼마나 좋아졌나요?`,
    `${contextLabel}에서 내가 직접 맡은 범위는 팀/프로젝트/사용자 영향 기준으로 어느 정도였나요?`,
  ];
}

function formatCandidateContext(candidate) {
  const description = typeof candidate?.description === "string" ? candidate.description.trim() : "";
  if (description) {
    return description;
  }

  const sectionLabel = sectionLabelFor(candidate?.section);
  const actionLabel = actionLabelFor(candidate?.action);
  if (sectionLabel && actionLabel) {
    return `${sectionLabel} ${actionLabel}`;
  }
  if (sectionLabel) {
    return `${sectionLabel} 항목`;
  }
  return "이 후보";
}

function sectionLabelFor(section) {
  switch (section) {
    case "summary":
      return "요약";
    case "experience":
      return "경력";
    case "projects":
      return "프로젝트";
    case "skills":
      return "기술";
    default:
      return "";
  }
}

function actionLabelFor(action) {
  switch (action) {
    case "append_bullet":
      return "불릿";
    case "update_summary":
      return "요약";
    case "add_skill":
      return "기술";
    case "add_experience":
      return "경력";
    case "delete_item":
      return "정리";
    default:
      return "";
  }
}
