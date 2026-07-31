/** analysis + handover → 적용 가능한 업무방식 프로필 markdown. 순수 함수. */
export function renderMemberProfile({ name, analysis, handover, generatedAt, windowDays }) {
  const L = [];
  L.push(`# ${name} — 업무방식`);
  L.push("");
  L.push("> ⚠️ 아래는 이 사람이 AI에게 남긴 **프롬프트에서 관찰된 패턴(가설)**입니다. 확정된 성격 규정이 아니며, 본인이 정정할 수 있습니다.");
  L.push("> 목적은 이 사람 \"행세\"가 아니라, 접근 방식을 **학습·참고**하는 것입니다.");
  L.push("");
  if (handover?.oneLiner) { L.push(`**한 줄 요약** — ${handover.oneLiner}`); L.push(""); }

  if (handover?.personaPrompt) {
    L.push("## 이 사람처럼 판단하기");
    L.push("_사람 체크리스트로도, AI에 붙이는 프롬프트로도 쓸 수 있습니다._");
    L.push("");
    L.push("> " + handover.personaPrompt.replace(/\n/g, "\n> "));
    L.push("");
  }

  L.push("## 판단 기준");
  const heur = handover?.heuristics ?? [];
  if (heur.length) {
    for (const h of heur) {
      L.push(`### ${h.principle}`);
      if (h.whenApplies) L.push(`- **언제** — ${h.whenApplies}`);
      if (h.example) L.push(`- **사례** — ${h.example}`);
      if (h.howToApply) L.push(`- **적용법** — ${h.howToApply}`);
      L.push("");
    }
  } else {
    for (const p of analysis?.principles ?? []) L.push(`- **${p.title}** — ${p.description}`);
    L.push("");
  }

  // "많이 한 일 · 1599회" 는 성과처럼 읽히지만 실제로는 AI 와 주고받은 횟수다. 프로젝트가
  // 크면 자연히 커지는 값이라 중요도 순으로 오해할 수 있어, 무엇을 센 건지 라벨에 밝힌다.
  L.push("## 주로 일한 영역");
  L.push("_AI 와 주고받은 프롬프트 수 기준입니다. 프로젝트 규모에 비례하므로 중요도 순은 아닙니다._");
  L.push("");
  for (const a of (analysis?.areas ?? []).slice(0, 8)) L.push(`- ${a.area} · 프롬프트 ${a.promptCount}건`);
  L.push("");

  if (handover && (handover.howToWork.length || handover.whatToAsk.length || handover.strengths.length)) {
    L.push("## 인수인계");
    if (handover.howToWork.length) { L.push("**이 사람과 일하는 법**"); handover.howToWork.forEach((s) => L.push(`- ${s}`)); L.push(""); }
    if (handover.whatToAsk.length) { L.push("**물어보면 좋은 것**"); handover.whatToAsk.forEach((s) => L.push(`- ${s}`)); L.push(""); }
    if (handover.strengths.length) { L.push("**강점**"); handover.strengths.forEach((s) => L.push(`- ${s}`)); L.push(""); }
  }

  L.push("---");
  L.push(`_생성: ${generatedAt} · 근거 창: 최근 ${windowDays}일 · 출처: Claude/Codex 프롬프트_`);
  return L.join("\n") + "\n";
}
