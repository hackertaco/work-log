/**
 * 프롬프트를 작업 영역(레포/프로젝트)별로 묶는다. 순수 함수 — LLM·I/O 없음.
 *
 * @param {Array<{text:string, projectPath:string, source:string, date:string}>} prompts
 * @param {{ topN?: number }} [opts]
 * @returns {{ areas: Array<{area:string, promptCount:number, firstDate:string, lastDate:string, prompts:string[]}>, droppedAreas:number }}
 */
export function groupWorkAreas(prompts, { topN = 5 } = {}) {
  const map = new Map();

  for (const p of Array.isArray(prompts) ? prompts : []) {
    const area = areaKey(p.projectPath);
    const entry = map.get(area) || { area, promptCount: 0, firstDate: null, lastDate: null, prompts: [] };
    entry.promptCount += 1;
    entry.prompts.push(String(p.text ?? ""));
    const date = String(p.date ?? "");
    if (date) {
      if (!entry.firstDate || date < entry.firstDate) entry.firstDate = date;
      if (!entry.lastDate || date > entry.lastDate) entry.lastDate = date;
    }
    map.set(area, entry);
  }

  const sorted = [...map.values()].sort((a, b) => b.promptCount - a.promptCount);
  return {
    areas: sorted.slice(0, topN),
    droppedAreas: Math.max(0, sorted.length - topN)
  };
}

function areaKey(projectPath) {
  const segments = String(projectPath ?? "")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  return segments.length ? segments[segments.length - 1] : "unknown";
}
