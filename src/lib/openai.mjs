const OPENAI_URL = process.env.WORK_LOG_OPENAI_URL || "https://api.openai.com/v1/responses";
const OPENAI_MODEL = process.env.WORK_LOG_OPENAI_MODEL || "gpt-5.4-mini";

export async function summarizeWithOpenAI(input) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || process.env.WORK_LOG_DISABLE_OPENAI === "1") {
    return null;
  }

  const payload = buildPayload(input);
  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI summary failed: ${response.status} ${errorText.slice(0, 400)}`);
  }

  const data = await response.json();
  const text = data.output_text || extractOutputText(data);
  if (!text) {
    throw new Error("OpenAI summary failed: empty output");
  }

  const parsed = JSON.parse(text);
  return {
    businessOutcomes: sanitizeBullets(parsed.business_outcomes),
    keyChanges: sanitizeBullets(parsed.key_changes),
    impact: sanitizeBullets(parsed.impact),
    whyItMatters: sanitizeBullets(parsed.why_it_matters),
    commitAnalysis: sanitizeBullets(parsed.commit_analysis),
    aiReview: sanitizeBullets(parsed.ai_review),
    resumeBullets: sanitizeBullets(parsed.resume_bullets)
  };
}

function buildPayload(input) {
  return {
    model: OPENAI_MODEL,
    reasoning: {
      effort: "low"
    },
    text: {
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "work_log_summary",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            business_outcomes: {
              type: "array",
              items: {
                type: "string"
              },
              minItems: 1,
              maxItems: 3
            },
            key_changes: {
              type: "array",
              items: {
                type: "string"
              },
              minItems: 0,
              maxItems: 4
            },
            impact: {
              type: "array",
              items: {
                type: "string"
              },
              minItems: 1,
              maxItems: 2
            },
            why_it_matters: {
              type: "array",
              items: {
                type: "string"
              },
              minItems: 1,
              maxItems: 2
            },
            commit_analysis: {
              type: "array",
              items: {
                type: "string"
              },
              minItems: 0,
              maxItems: 3
            },
            ai_review: {
              type: "array",
              items: {
                type: "string"
              },
              minItems: 2,
              maxItems: 4
            },
            resume_bullets: {
              type: "array",
              items: {
                type: "string"
              },
              minItems: 1,
              maxItems: 3
            }
          },
          required: ["business_outcomes", "key_changes", "impact", "why_it_matters", "commit_analysis", "ai_review", "resume_bullets"]
        }
      }
    },
    max_output_tokens: 900,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              "You summarize a developer's day into concise Korean bullets. Git commits are the strongest signal for what work was actually done; use them first for business_outcomes, key_changes, impact, why_it_matters, commit_analysis, ai_review, and resume_bullets. Session logs are not the source of shipped work. Use session logs only as a weak signal for how the developer thinks, prioritizes, or handles risk. IMPORTANT: the arrays business_outcomes, key_changes, impact, and why_it_matters must align by index. Item 1 in each array should describe the same thread of work, item 2 the next thread, and so on. Write business_outcomes as end-user, operator, or business-facing results first, not implementation details. Write key_changes as the concrete technical changes that produced those outcomes. why_it_matters should explain who benefits or what risk/cost/time is reduced. commit_analysis must not repeat raw commit titles; instead, summarize what technologies, systems, or product areas were worked on and what kind of changes were made there. ai_review should feel like a thoughtful staff-level review of the person's work today: what strengths showed up, what risks or blind spots remain, what this suggests about their working style, and what the strongest resume angle is. Do not echo questions, chat boilerplate, session IDs, wrapper names, backup-file cleanup details, or prompt filenames unless they materially changed the product. Use user-facing, organized Korean language suitable for a personal work log. Keep every bullet short and concrete, ideally under 110 Korean characters."
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify(input, null, 2)
          }
        ]
      }
    ]
  };
}

function extractOutputText(data) {
  const outputs = data.output || [];
  const texts = [];
  for (const item of outputs) {
    const content = item?.content || [];
    for (const part of content) {
      if (part?.type === "output_text" && part?.text) {
        texts.push(part.text);
      }
    }
  }
  return texts.join("\n").trim();
}

function sanitizeBullets(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim())
    .map((item) => item.replace(/^[`"'[\],.\s]+|[`"'[\],.\s]+$/g, "").trim())
    .map((item) => item.replace(/\.`,`/g, ". ").replace(/`\],/g, "").replace(/`\],/g, ""))
    .filter(Boolean)
    .filter((item) => !/[{}\[\]]/.test(item))
    .slice(0, 6);
}
