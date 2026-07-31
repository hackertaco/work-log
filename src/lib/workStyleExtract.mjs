/**
 * 한 작업 영역의 프롬프트에서 "한 일 + 꺼낸 판단(암묵지)"을 LLM으로 추출한다.
 * 프롬프트는 주로 "묻는" 기록이라 확정적 성격 규정 대신 근거에서 드러나는 판단만 뽑는다.
 * 실패·미설정은 비치명적 — 빈 결과를 반환한다.
 */
import { extractOutputText } from "./openai.mjs";

const OPENAI_URL = process.env.WORK_LOG_OPENAI_URL || "https://api.openai.com/v1/responses";
const OPENAI_MODEL = process.env.WORK_LOG_OPENAI_MODEL || "gpt-5.4-mini";
const MAX_PROMPTS = 60;

export async function extractWorkStyleForArea(areaGroup, behavior = null, fetchImpl = fetch) {
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
      body: JSON.stringify(buildExtractPayload(area, prompts, behavior))
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

/**
 * 영역별로 뽑아낸 개별 판단들을 가로질러, 이 사람이 반복적으로 적용하는
 * "판단 기준 / 사고방식" 3~5개로 승격(합성)한다. 개별 결정이 아니라 그것들을
 * 관통하는 원칙을 뽑는 게 목적. 미설정/판단 없음/실패는 비치명적 — 빈 배열.
 *
 * @param {Array<{area:string, judgments:{text:string,evidence:string}[]}>} areas
 * @returns {Promise<Array<{title:string, description:string}>>}
 */
export async function synthesizeWorkStylePrinciples(areas, behaviorByArea = null, fetchImpl = fetch) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || process.env.WORK_LOG_DISABLE_OPENAI === "1") return [];

  const items = (Array.isArray(areas) ? areas : [])
    .flatMap((a) => (a?.judgments ?? []).map((j) => ({ area: a.area, text: String(j?.text ?? "").trim() })))
    .filter((j) => j.text)
    .slice(0, 40);
  if (!items.length) return [];

  try {
    const response = await fetchImpl(OPENAI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(buildSynthesisPayload(items, behaviorByArea))
    });
    if (!response.ok) return [];

    const data = await response.json();
    const text = data.output_text || extractOutputText(data) || "";
    if (!text) return [];

    const parsed = JSON.parse(text);
    return (Array.isArray(parsed.principles) ? parsed.principles : [])
      .map((p) => ({ title: String(p?.title ?? "").trim(), description: String(p?.description ?? "").trim() }))
      .filter((p) => p.title)
      .slice(0, 5);
  } catch {
    return [];
  }
}

function pct(v) {
  return v == null ? null : `${Math.round(v * 100)}%`;
}

/**
 * 행동신호 요약을 LLM 이 읽을 한국어 근거 블록으로 만든다. 순수 함수.
 * 신호가 없거나 세션이 0이면 빈 문자열 — 호출자는 v1 페이로드를 그대로 쓴다.
 */
export function formatBehaviorContext(behavior) {
  if (!behavior || !behavior.sessionCount) return "";

  const lines = [`- 세션 ${behavior.sessionCount}개`];
  if (behavior.avgFrustration != null) {
    const density = behavior.frustrationDensity != null ? ` (요청당 밀도 ${behavior.frustrationDensity})` : "";
    lines.push(`- 평균 좌절 점수 ${behavior.avgFrustration}${density}`);
  }
  if (behavior.retryRate != null) lines.push(`- 재시도 비율 ${pct(behavior.retryRate)}`);
  if (behavior.efficiency != null) lines.push(`- 효율 지표 ${behavior.efficiency}`);
  if (behavior.verificationRatio != null) lines.push(`- 검증 목적 툴 사용 비중 ${pct(behavior.verificationRatio)}`);
  const tools = (Array.isArray(behavior.topTools) ? behavior.topTools : []).filter(
    (t) => t?.tool && t?.count != null
  );
  if (tools.length) {
    lines.push(
      `- 많이 쓴 툴: ${tools.map((t) => `${t.tool} ${t.count}회${t.isVerification ? "(검증)" : ""}`).join(", ")}`
    );
  }

  return `행동신호(같은 기간 실제 관찰된 것):\n${lines.join("\n")}`;
}

const BEHAVIOR_INSTRUCTION =
  ` 함께 주는 "행동신호"는 같은 기간 실제로 관찰된 도구 사용·재시도·좌절 수치다. ` +
  `이건 판단을 뒷받침하거나 정정하는 근거로만 쓰라. 수치를 그대로 나열하지 말고 ` +
  `판단의 근거 설명 안에 자연스럽게 녹여라(예: "검증을 먼저 돌린다" — 실제로 검증 툴 비중이 높음). ` +
  `프롬프트에서 읽은 판단이 행동신호와 어긋나면 단정하지 말고 약하게 서술하라. ` +
  `행동신호만으로 새 판단을 만들어내지 말 것.`;

export function buildExtractPayload(area, prompts, behavior = null) {
  const behaviorContext = formatBehaviorContext(behavior);
  const instruction =
    `아래는 사용자가 "${area}" 작업을 하며 AI에게 입력한 프롬프트들이다. ` +
    `이 프롬프트만 근거로, (1) 이 영역에서 무슨 일을 했는지(did), ` +
    `(2) 어떤 판단·기준·원칙을 가지고 일했는지(judgments)를 한국어로 추출하라. ` +
    `각 judgment는 실제 프롬프트에서 인용 가능한 근거(evidence)가 있어야 한다. ` +
    `근거 없는 일반론이나 성격 규정은 금지. 프롬프트는 주로 '묻는' 기록이므로 단정하지 말고 근거에서 드러나는 것만.` +
    (behaviorContext ? BEHAVIOR_INSTRUCTION : "");

  const userContent = prompts.map((p, i) => `${i + 1}. ${p}`).join("\n");

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
      { role: "user", content: behaviorContext ? `${userContent}\n\n${behaviorContext}` : userContent }
    ]
  };
}

export function buildSynthesisPayload(items, behaviorByArea = null) {
  const behaviorBlocks = Object.entries(behaviorByArea ?? {})
    .map(([area, b]) => {
      const text = formatBehaviorContext(b);
      return text ? `[${area}] ${text}` : "";
    })
    .filter(Boolean);

  const instruction =
    `아래는 한 사람이 여러 작업 영역에서 내린 개별 판단들이다(각 줄: [영역] 판단). ` +
    `이 판단들을 가로질러 반복적으로 드러나는, 이 사람이 일할 때 가진 ` +
    `"판단 기준·사고방식·원칙"을 3~5개로 합성하라. 개별 결정을 그대로 나열하지 말고, ` +
    `여러 영역에 걸쳐 반복되는 상위 패턴으로 승격할 것. ` +
    `각 원칙은 title(한 문장 원칙 — 예: "공유·합의 가능성을 품질 기준으로 둔다")과 ` +
    `description(그 원칙이 어떻게 드러나는지 1~2문장)으로. 한국어로. ` +
    `제공된 판단에서 실제로 뒷받침되는 것만. 근거 없는 성격 규정·일반론 금지.` +
    (behaviorBlocks.length ? BEHAVIOR_INSTRUCTION : "");

  const judgmentText = items.map((j) => `[${j.area}] ${j.text}`).join("\n");
  const userContent = behaviorBlocks.length
    ? `${judgmentText}\n\n${behaviorBlocks.join("\n\n")}`
    : judgmentText;

  return {
    model: OPENAI_MODEL,
    reasoning: { effort: "low" },
    max_output_tokens: 3000,
    text: {
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "workstyle_principles",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["principles"],
          properties: {
            principles: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["title", "description"],
                properties: { title: { type: "string" }, description: { type: "string" } }
              }
            }
          }
        }
      }
    },
    input: [
      { role: "system", content: instruction },
      { role: "user", content: userContent }
    ]
  };
}
