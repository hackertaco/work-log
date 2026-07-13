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

/**
 * 프롬프트의 작업 경로에서 "프로젝트 루트"를 뽑는다. 세션은 프로젝트의 하위
 * 폴더에서 열리는 경우가 많아 마지막 세그먼트를 그냥 쓰면 지저분해진다
 * (예: .../driving-teacher-knowledge-base/graph-v2 → graph-v2). 알려진 루트
 * 마커 다음 세그먼트를 프로젝트로 본다.
 *
 *   .../company-code/<repo>/...   → <repo>
 *   .../opensource/<repo>/...     → <repo>
 *   .../Codex/<YYYY-MM-DD>/<proj> → <proj>
 *   그 외                          → 마지막 세그먼트(확장자 있으면 상위 폴더)
 */
export function areaKey(projectPath) {
  const segments = String(projectPath ?? "").split("/").map((s) => s.trim()).filter(Boolean);
  if (!segments.length) return "unknown";

  for (const marker of ["company-code", "opensource"]) {
    const i = segments.indexOf(marker);
    if (i >= 0 && segments[i + 1]) return segments[i + 1];
  }

  const codex = segments.indexOf("Codex");
  if (codex >= 0) {
    const after = segments[codex + 1];
    // Codex/<날짜>/<프로젝트> — 날짜면 한 칸 더
    if (after && /^\d{4}-\d{2}-\d{2}$/.test(after) && segments[codex + 2]) return segments[codex + 2];
    if (after) return after;
  }

  const last = segments[segments.length - 1];
  // 마지막이 파일이면(확장자) 상위 폴더를 쓴다
  if (/\.[a-z0-9]+$/i.test(last) && segments.length >= 2) return segments[segments.length - 2];
  return last;
}
