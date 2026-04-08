/**
 * resumeAgentTools.mjs — Agent tool definitions and executor for the resume agent.
 *
 * Defines 4 tools used by the ReAct loop:
 *   1. search_evidence  — search worklog sources for evidence
 *   2. read_draft_context — read cached draft from Vercel Blob
 *   3. update_section   — propose a diff for user approval (interrupt)
 *   4. ask_user         — ask the user a question (interrupt)
 */

import { searchAllSources } from "./resumeEvidenceSearch.mjs";
import { analyzeQuery } from "./resumeQueryAnalyzer.mjs";
import { readChatDraft, readChatDraftContext } from "./blob.mjs";

// ─── Tool definitions (OpenAI Responses API format) ─────────────────────────

export const TOOL_DEFINITIONS = [
  {
    type: "function",
    name: "search_evidence",
    description:
      "워크로그에서 근거를 검색합니다. 커밋, 슬랙, 세션 메모리 등 모든 소스를 대상으로 키워드 기반 검색을 수행합니다.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "검색할 자연어 쿼리 (예: 'React 성능 최적화 작업')",
        },
        sources: {
          type: "array",
          items: { type: "string" },
          description:
            "검색할 소스 목록 (예: ['commits', 'slack', 'sessions']). 생략하면 모든 소스 검색.",
        },
        dateRange: {
          type: "object",
          properties: {
            from: { type: "string", description: "시작일 (YYYY-MM-DD)" },
            to: { type: "string", description: "종료일 (YYYY-MM-DD)" },
          },
          description: "검색 기간 제한",
        },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "read_draft_context",
    description:
      "Vercel Blob에 캐시된 이력서 초안과 근거 풀을 읽어옵니다. 배치 훅이 생성한 최신 초안을 반환합니다.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    type: "function",
    name: "update_section",
    description:
      "이력서 섹션에 대한 수정 제안(diff)을 생성합니다. 사용자 승인을 위해 에이전트 루프를 중단합니다.",
    parameters: {
      type: "object",
      properties: {
        section: {
          type: "string",
          description: "수정할 섹션 이름 (예: 'experience', 'strengths', 'skills')",
        },
        operation: {
          type: "string",
          description: "수정 작업 유형 (예: 'add', 'replace', 'remove', 'rewrite')",
        },
        payload: {
          type: "object",
          description: "수정 내용 (섹션과 작업에 따라 구조가 다름)",
        },
        evidence: {
          type: "array",
          items: { type: "object" },
          description: "수정 근거가 되는 증거 목록 (선택)",
        },
      },
      required: ["section", "operation", "payload"],
    },
  },
  {
    type: "function",
    name: "ask_user",
    description:
      "사용자에게 질문을 보냅니다. 추가 정보가 필요할 때 에이전트 루프를 중단하고 사용자 응답을 기다립니다.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "사용자에게 보낼 질문",
        },
        context: {
          type: "string",
          description: "질문의 배경/맥락 설명 (선택)",
        },
      },
      required: ["question"],
    },
  },
];

// ─── Interrupt detection ────────────────────────────────────────────────────

const INTERRUPT_TOOLS = new Set(["ask_user", "update_section"]);

/**
 * Returns true if the given tool name produces an interrupt signal,
 * meaning the agent loop should pause and wait for user input.
 */
export function isInterruptTool(name) {
  return INTERRUPT_TOOLS.has(name);
}

// ─── Tool implementations ───────────────────────────────────────────────────

async function executeSearchEvidence({ query, sources, dateRange }) {
  const analyzed = analyzeQuery(query);

  // Filter sourceParams to only requested sources
  if (sources) {
    for (const key of Object.keys(analyzed.sourceParams || {})) {
      if (!sources.includes(key)) delete analyzed.sourceParams[key];
    }
  }

  if (dateRange) analyzed.dateRange = dateRange;

  const result = await searchAllSources(analyzed, {});

  // Handle both old (array) and new ({ ranked, totalCount, errors }) return format
  const ranked = result.ranked || result;
  return {
    results: (Array.isArray(ranked) ? ranked : []).slice(0, 15).map((r) => ({
      id: r.id,
      source: r.source || r._source,
      text: r.text || r.summary || r.message,
      relevanceScore: r.relevanceScore,
      date: r.date,
    })),
    totalCount: result.totalCount || (Array.isArray(result) ? result.length : 0),
    errors: result.errors || [],
  };
}

async function executeReadDraftContext() {
  const [draft, context] = await Promise.all([
    readChatDraft(),
    readChatDraftContext(),
  ]);

  if (!draft && !context) {
    return { draft: null, reason: "no_cache" };
  }

  return {
    draft: context?.draft || draft,
    evidencePool: context?.evidencePool || null,
    sourceBreakdown: context?.sourceBreakdown || null,
    cachedAt: context?.cachedAt || draft?.cachedAt || null,
    dateRange: context?.dateRange || draft?.dateRange || null,
  };
}

function executeUpdateSection({ section, operation, payload, evidence }) {
  const messageId = `diff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    _interrupt: true,
    diff: { section, operation, payload, evidence: evidence || [] },
    messageId,
  };
}

function executeAskUser({ question, context }) {
  return {
    _interrupt: true,
    question,
    context: context || null,
  };
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

const TOOL_MAP = {
  search_evidence: executeSearchEvidence,
  read_draft_context: executeReadDraftContext,
  update_section: executeUpdateSection,
  ask_user: executeAskUser,
};

/**
 * Execute a tool by name with the given arguments.
 *
 * @param {string} name   Tool name (must be one of the 4 defined tools)
 * @param {object} args   Tool arguments
 * @returns {Promise<object>}  Tool result
 */
export async function executeTool(name, args) {
  const handler = TOOL_MAP[name];
  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }
  return handler(args);
}
