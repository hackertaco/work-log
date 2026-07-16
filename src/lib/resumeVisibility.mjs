/**
 * 레주메 노출 가시성. WORK_LOG_ENABLE_RESUME === "1" 일 때만 레주메성 데이터를
 * 응답에 포함한다. off(Vercel v1 기본)면 응답 경계에서 제거한다. 생성 파이프라인은
 * 건드리지 않는다(로컬 v2와 코드 공유).
 */
export function resumeEnabled() {
  return process.env.WORK_LOG_ENABLE_RESUME === "1";
}

export function stripResumeFields(summary) {
  if (resumeEnabled() || !summary || typeof summary !== "object") return summary;
  const { resume, ...rest } = summary;
  return rest;
}

export function stripResumeDraft(profile) {
  if (resumeEnabled() || !profile || typeof profile !== "object") return profile;
  const { resumeDraft, ...rest } = profile;
  return rest;
}
