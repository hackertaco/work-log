/**
 * 한 작업 영역의 프롬프트에서 "한 일 + 꺼낸 판단(암묵지)"을 LLM으로 추출한다.
 * 프롬프트는 주로 "묻는" 기록이라 확정적 성격 규정 대신 근거에서 드러나는 판단만 뽑는다.
 * 실패·미설정은 비치명적 — 빈 결과를 반환한다.
 */
import { extractOutputText } from "./openai.mjs";

const OPENAI_URL = process.env.WORK_LOG_OPENAI_URL || "https://api.openai.com/v1/responses";
const OPENAI_MODEL = process.env.WORK_LOG_OPENAI_MODEL || "gpt-5.4-mini";
const MAX_PROMPTS = 60;

export async function extractWorkStyleForArea(areaGroup, fetchImpl = fetch) {
  const area = areaGroup?.area ?? "unknown";
  const empty = { area, did: [], judgments: [] };

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || process.env.WORK_LOG_DISABLE_OPENAI === "1") return empty;

  const prompts = (areaGroup?.prompts ?? []).slice(0, MAX_PROMPTS).map((p) => String(p).slice(0, 300));
  if (!prompts.length) return empty;

  try {
    const response = await fetchImpl(OPENAI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildExtractPayload(area, prompts))
    });
    if (!response.ok) return empty;

    const data = await response.json();
    const text = data.output_text || extractOutputText(data) || "";
    if (!text) return empty;

    const parsed = JSON.parse(text);
    return {
      area,
      did: sanitizeList(parsed.did),
      judgments: (Array.isArray(parsed.judgments) ? parsed.judgments : [])
        .map((j) => ({ text: String(j?.text ?? "").trim(), evidence: String(j?.evidence ?? "").trim() }))
        .filter((j) => j.text)
        .slice(0, 5)
    };
  } catch {
    return empty;
  }
}

function sanitizeList(v) {
  return (Array.isArray(v) ? v : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 6);
}

export function buildExtractPayload(area, prompts) {
  const instruction =
    `아래는 사용자가 "${area}" 작업을 하며 AI에게 입력한 프롬프트들이다. ` +
    `이 프롬프트만 근거로, (1) 이 영역에서 무슨 일을 했는지(did), ` +
    `(2) 어떤 판단·기준·원칙을 가지고 일했는지(judgments)를 한국어로 추출하라. ` +
    `각 judgment는 실제 프롬프트에서 인용 가능한 근거(evidence)가 있어야 한다. ` +
    `근거 없는 일반론이나 성격 규정은 금지. 프롬프트는 주로 '묻는' 기록이므로 단정하지 말고 근거에서 드러나는 것만.`;

  return {
    model: OPENAI_MODEL,
    reasoning: { effort: "low" },
    // reasoning 토큰이 이 예산에서 먼저 차감되므로 넉넉히 잡는다. 너무 낮으면
    // (예: 600) 추론이 예산을 먹고 JSON 출력이 truncate → status:incomplete →
    // output_text 빈 문자열이 되어 판단이 통째로 사라진다. (2026-07-07 프로덕션 회귀)
    max_output_tokens: 3000,
    text: {
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "workstyle_area",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["did", "judgments"],
          properties: {
            did: { type: "array", items: { type: "string" } },
            judgments: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["text", "evidence"],
                properties: { text: { type: "string" }, evidence: { type: "string" } }
              }
            }
          }
        }
      }
    },
    input: [
      { role: "system", content: instruction },
      { role: "user", content: prompts.map((p, i) => `${i + 1}. ${p}`).join("\n") }
    ]
  };
}
