/**
 * 그날 한 프로젝트에서 실제로 무슨 일이 있었는지를, 그날의 커밋과 프롬프트로 쓴다.
 *
 * 이전에는 레포 이름별 if 문 안에 사람이 미리 써둔 문장을 키워드로 골라 보여줬다.
 * 목록에 없는 레포는 "<레포>에서 진행한 핵심 흐름을 정리하고 개선함" 같은 기본값으로
 * 떨어졌고, impact/why 는 아예 모든 날 같은 문장이 박혀 있었다. 틀릴 수 없는 문장은
 * 아무것도 알려주지 않는다 — 그래서 실제 기록을 읽어 쓰게 바꿨다.
 *
 * 커밋은 "무엇을 바꿨나"를, 프롬프트는 "왜 그랬나"를 담고 있어서 둘 다 넣는다.
 * 실패·미설정은 비치명적 — 빈 배열을 돌려주고 호출자가 사실 기반 폴백을 쓴다.
 */
import { extractOutputText } from "./openai.mjs";
import {
  getLlmBearerToken,
  getLlmModel,
  isLlmDisabled,
  requestLlmResponse
} from "./llmGateway.mjs";

const MAX_PROJECTS = 3;
const MAX_COMMITS = 12;
const MAX_PROMPTS = 20;

/**
 * 그날 프롬프트를 레포별로 나눈다. 순수 함수.
 * @param {Array<{text?:string, projectPath?:string}>} prompts
 * @param {(path:string)=>string} areaKeyFn  serverCollect 와 같은 규칙을 쓰기 위해 주입받는다
 * @returns {Map<string, string[]>}
 */
export function groupPromptsByRepo(prompts, areaKeyFn) {
  const map = new Map();
  for (const p of Array.isArray(prompts) ? prompts : []) {
    const text = String(p?.text ?? "").trim();
    if (!text) continue;
    const repo = areaKeyFn(p?.projectPath);
    if (!map.has(repo)) map.set(repo, []);
    map.get(repo).push(text.slice(0, 300));
  }
  return map;
}

export function buildDayStoryPayload(date, projects) {
  const instruction =
    `아래는 한 사람이 ${date} 하루 동안 프로젝트별로 남긴 커밋과 AI 프롬프트다. ` +
    `프로젝트마다 그날의 이야기를 outcome·keyChange·impact·why 로 써라. 한국어.\n` +
    // 이 판정 기준이 이 프롬프트의 핵심이다. 이게 없으면 모델은 안전한 일반론으로 도망간다.
    `**판정 기준: 그날 그 프로젝트에만 참인 문장을 써라.** 다른 날이나 다른 프로젝트에 ` +
    `그대로 옮겨도 말이 되는 문장은 실패한 것이다. 쓰기 전에 "이 문장을 지난주 기록에 ` +
    `붙여도 맞는 말인가?"를 자문하고, 맞다면 다시 써라.\n` +
    `금지: "핵심 흐름을 정리하고 개선함", "오류 가능성을 줄임", "안정성을 높임", ` +
    `"품질을 개선함" 같은 무엇에도 들어맞는 표현. 대상과 사건을 지목하라 — ` +
    `무엇이 막혔고, 무엇을 어떻게 바꿨고, 그래서 무엇이 달라졌는지.\n` +
    `outcome: 그날 이 프로젝트에서 벌어진 일 한 문장(제목으로 쓰인다). ` +
    `keyChange: 실제로 바뀐 것. impact: 그래서 달라지는 것. why: 왜 중요한지.\n` +
    `커밋은 무엇을 바꿨는지를, 프롬프트는 왜 그렇게 했는지를 담고 있다. 둘을 이어서 읽어라. ` +
    `프롬프트에 이유가 드러나면 why 에 그 맥락을 쓰라. ` +
    `근거가 부족한 항목은 지어내지 말고 빈 문자열로 두라. 빈 칸이 그럴듯한 거짓말보다 낫다.`;

  const body = projects
    .map((p) => {
      const commits = (p.commits ?? []).slice(0, MAX_COMMITS).map((c) => `  - ${c}`).join("\n");
      const prompts = (p.prompts ?? []).slice(0, MAX_PROMPTS).map((t) => `  - ${t}`).join("\n");
      return `## ${p.repo}\n커밋:\n${commits || "  (없음)"}\n프롬프트:\n${prompts || "  (없음)"}`;
    })
    .join("\n\n");

  return {
    model: getLlmModel(),
    reasoning: { effort: "low" },
    // workStyleExtract 와 같은 이유로 넉넉히 — 낮추면 reasoning 이 예산을 먹고 출력이 잘린다.
    max_output_tokens: 3000,
    text: {
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "day_stories",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["stories"],
          properties: {
            stories: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["repo", "outcome", "keyChange", "impact", "why"],
                properties: {
                  repo: { type: "string" },
                  outcome: { type: "string" },
                  keyChange: { type: "string" },
                  impact: { type: "string" },
                  why: { type: "string" }
                }
              }
            }
          }
        }
      }
    },
    input: [
      { role: "system", content: instruction },
      { role: "user", content: body }
    ]
  };
}

/**
 * @param {{date:string, projects:Array<{repo:string, commits:string[], prompts:string[]}>, fetchImpl?:typeof fetch}} opts
 * @returns {Promise<Array<{repo:string, outcome:string, keyChange:string, impact:string, why:string}>>}
 */
export async function summarizeDayStories({ date, projects, fetchImpl = fetch } = {}) {
  const apiKey = getLlmBearerToken();
  if (!apiKey || isLlmDisabled()) return [];

  const usable = (Array.isArray(projects) ? projects : [])
    .filter((p) => p?.repo && ((p.commits?.length ?? 0) || (p.prompts?.length ?? 0)))
    .slice(0, MAX_PROJECTS);
  if (!usable.length) return [];

  try {
    const response = await requestLlmResponse(buildDayStoryPayload(date, usable), {
      apiKey,
      fetchImpl,
      operation: "day-story"
    });
    if (!response.ok) return [];

    const data = await response.json();
    const text = data.output_text || extractOutputText(data) || "";
    if (!text) return [];

    const parsed = JSON.parse(text);
    const str = (v) => String(v ?? "").trim();
    return (Array.isArray(parsed.stories) ? parsed.stories : [])
      .map((s) => ({
        repo: str(s?.repo),
        outcome: str(s?.outcome),
        keyChange: str(s?.keyChange),
        impact: str(s?.impact),
        why: str(s?.why)
      }))
      // 제목이 없으면 카드로 쓸 수 없다. 나머지 빈 칸은 화면이 알아서 감춘다.
      .filter((s) => s.repo && s.outcome)
      .slice(0, MAX_PROJECTS);
  } catch {
    return [];
  }
}
