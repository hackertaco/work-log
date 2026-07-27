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
    const strs = (v) => (Array.isArray(v) ? v : []).map((s) => String(s).trim()).filter(Boolean).slice(0, 8);
    return {
      oneLiner: String(p.oneLiner ?? "").trim(),
      personaPrompt: String(p.personaPrompt ?? "").trim(),
      howToWork: strs(p.howToWork), whatToAsk: strs(p.whatToAsk), strengths: strs(p.strengths),
      heuristics: (Array.isArray(p.heuristics) ? p.heuristics : []).map((h) => ({
        principle: String(h?.principle ?? "").trim(), whenApplies: String(h?.whenApplies ?? "").trim(),
        example: String(h?.example ?? "").trim(), howToApply: String(h?.howToApply ?? "").trim()
      })).filter((h) => h.principle).slice(0, 8)
    };
  } catch { return null; }
}

export function buildHandoverPayload(analysis) {
  const principles = (analysis?.principles ?? []).map((p) => `- ${p.title}: ${p.description}`).join("\n");
  const judgments = (analysis?.areas ?? [])
    .flatMap((a) => (a.judgments ?? []).map((j) => `[${a.area}] ${j.text} (근거: ${j.evidence})`)).slice(0, 40).join("\n");
  const instruction =
    `아래는 한 사람의 판단 기준(원칙)과 영역별 판단(근거 포함)이다. 이것을 "남이 그대로 적용할 수 있는" 형태로 변환하라. 한국어. ` +
    `heuristics: 각 원칙을 principle(원칙)·whenApplies(어떤 상황에서 발동)·example(근거 프롬프트에서 온 실제 사례)·howToApply(남이 적용하는 법)로. ` +
    `personaPrompt: 원칙들을 증류한, 사람 체크리스트로도 AI 시스템 프롬프트로도 재사용 가능한 "이 사람처럼 판단하기" 한 단락. ` +
    `oneLiner: 한 줄 요약. howToWork/whatToAsk/strengths: 인수인계용 짧은 목록. ` +
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
