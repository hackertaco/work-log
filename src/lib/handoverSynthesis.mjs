import { extractOutputText } from "./openai.mjs";

const OPENAI_URL = process.env.WORK_LOG_OPENAI_URL || "https://api.openai.com/v1/responses";
const OPENAI_MODEL = process.env.WORK_LOG_OPENAI_MODEL || "gpt-5.4-mini";

export async function synthesizeHandover(analysis, fetchImpl = fetch) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || process.env.WORK_LOG_DISABLE_OPENAI === "1") return null;
  const principles = Array.isArray(analysis?.principles) ? analysis.principles : [];
  if (!principles.length) return null;

  try {
    const response = await fetchImpl(OPENAI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildHandoverPayload(analysis))
    });
    if (!response.ok) return null;
    const data = await response.json();
    const text = data.output_text || extractOutputText(data) || "";
    if (!text) return null;
    const p = JSON.parse(text);
    const strs = (v) => (Array.isArray(v) ? v : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 5);
    return {
      oneLiner: String(p.oneLiner ?? "").trim(),
      personaPrompt: String(p.personaPrompt ?? "").trim(),
      howToWork: strs(p.howToWork), whatToAsk: strs(p.whatToAsk), strengths: strs(p.strengths),
      heuristics: (Array.isArray(p.heuristics) ? p.heuristics : []).map((h) => ({
        principle: String(h?.principle ?? "").trim(), whenApplies: String(h?.whenApplies ?? "").trim(),
        example: String(h?.example ?? "").trim(), howToApply: String(h?.howToApply ?? "").trim()
      })).filter((h) => h.principle).slice(0, 5)
    };
  } catch { return null; }
}

export function buildHandoverPayload(analysis) {
  const principles = (analysis?.principles ?? []).map((p) => `- ${p.title}: ${p.description}`).join("\n");
  const judgments = (analysis?.areas ?? [])
    .flatMap((a) => (a.judgments ?? []).map((j) => `[${a.area}] ${j.text} (근거: ${j.evidence})`)).slice(0, 40).join("\n");
  const instruction =
    `아래는 한 사람의 판단 기준(원칙)과 영역별 판단(근거 포함)이다. 이것을 "남이 그대로 적용할 수 있는" 형태로 변환하라. 한국어. ` +
    `heuristics: 각 원칙을 principle(원칙)·whenApplies(어떤 상황에서 발동)·example(실제 사례)·howToApply(남이 적용하는 법)로. ` +
    // 이 사람이 실제로 친 말이 이 문서에서 제일 믿음직한 부분이다. 요약하면 다른 누구의
    // 프로필이라 해도 말이 되는 일반론이 된다(2026-07-31 발행본에서 실제로 그렇게 됐다).
    `example 은 반드시 아래 근거에 있는 **원문을 그대로 따옴표로 인용**하라. 여러 개면 " / " 로 잇는다. ` +
    `말투·오타를 고치지 말고, 요약하거나 바꿔 쓰지 마라. 인용할 원문이 없으면 그 heuristic 은 빼라. ` +
    // 8개까지 뽑으면 서로 겹치면서 힘이 흩어진다. 겹치는 건 합치고 굵은 것만 남긴다.
    `heuristics 는 3~5개로만. 비슷한 것끼리는 합치고, 가장 반복적으로 드러나는 것만 남겨라. ` +
    // 원칙 설명에는 "말뿐 아니라 실제 도구 사용·재시도로 뒷받침된다" 같은 행동 근거가 들어
    // 있는데, 다시 쓰면서 이게 통째로 사라졌다(2026-07-31 발행본 확인). 명시적으로 지킨다.
    `원칙 설명에 "실제 행동으로 뒷받침된다/어긋난다"는 언급이 있으면 그 근거를 heuristics 와 ` +
    `personaPrompt 에 반드시 남겨라. 수치를 옮겨 적지는 말고 문장으로. 이건 이 사람이 말로만 ` +
    `그러는지 실제로 그러는지를 가르는 정보라 빼면 안 된다. ` +
    `personaPrompt: 원칙들을 증류한, 사람 체크리스트로도 AI 시스템 프롬프트로도 재사용 가능한 "이 사람처럼 판단하기" 한 단락. ` +
    `oneLiner: 한 줄 요약. howToWork/whatToAsk/strengths: 인수인계용 짧은 목록(각 5개 이내). ` +
    `제공된 근거로 뒷받침되는 것만. 근거 없는 성격 규정·일반론·미화 금지.`;
  const item = (name, req) => ({ type: "array", items: { type: "object", additionalProperties: false, required: req, properties: Object.fromEntries(req.map((k) => [k, { type: "string" }])) } });
  return {
    model: OPENAI_MODEL, reasoning: { effort: "low" }, max_output_tokens: 3000,
    text: {
      verbosity: "low",
      format: {
        type: "json_schema", name: "handover", strict: true,
        schema: {
          type: "object", additionalProperties: false,
          required: ["oneLiner", "personaPrompt", "howToWork", "whatToAsk", "strengths", "heuristics"],
          properties: {
            oneLiner: { type: "string" }, personaPrompt: { type: "string" },
            howToWork: { type: "array", items: { type: "string" } },
            whatToAsk: { type: "array", items: { type: "string" } },
            strengths: { type: "array", items: { type: "string" } },
            heuristics: item("heuristics", ["principle", "whenApplies", "example", "howToApply"])
          }
        }
      }
    },
    input: [
      { role: "system", content: instruction },
      { role: "user", content: `## 원칙\n${principles}\n\n## 영역별 판단(근거)\n${judgments}` }
    ]
  };
}
