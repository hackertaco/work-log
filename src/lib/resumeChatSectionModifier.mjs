/**
 * resumeChatSectionModifier.mjs
 *
 * AC 5 Sub-AC 2: 대화 컨텍스트에서 구체화된 내용을 기반으로
 * 이력서 JSON의 해당 섹션을 수정한 새 JSON을 생성하는 로직.
 *
 * 이 모듈은 두 가지 입력 경로를 통합한다:
 *
 *   1. RefinedSuggestion[] (refineSectionWithChat 의 구조화된 출력)
 *      → convertSuggestionsToChanges() 로 ProposedChange[] 변환
 *      → applyChatChangesToResume() 으로 이력서 수정
 *
 *   2. 대화 히스토리 ({ role, content }[])
 *      → extractRefinedContentFromHistory() 로 어시스턴트 응답에서 구체화된 내용 추출
 *      → convertSuggestionsToChanges() 로 변환
 *      → applyChatChangesToResume() 으로 이력서 수정
 *
 * ─── 주요 함수 ─────────────────────────────────────────────────────────────────
 *
 *   generateModifiedResume(resumeDoc, section, options)
 *     대화 컨텍스트의 구체화된 내용으로 이력서 JSON을 수정한 새 객체를 생성한다.
 *     → ModifiedResumeResult
 *
 *   convertSuggestionsToChanges(suggestions, section)
 *     RefinedSuggestion[] 를 ProposedChange[] 로 변환한다.
 *     → ProposedChange[]
 *
 *   extractRefinedContentFromHistory(history, section)
 *     대화 히스토리에서 가장 최근 구체화된 내용을 추출하여 RefinedSuggestion[] 로 변환한다.
 *     → RefinedSuggestion[]
 *
 *   validateModifiedSection(updatedDoc, section, originalDoc)
 *     수정된 섹션이 스키마를 위반하지 않는지 검증한다.
 *     → ValidationResult
 *
 * ─── 타입 ─────────────────────────────────────────────────────────────────────
 *
 *   ModifiedResumeResult — {
 *     updatedDoc:     object,            // 수정된 이력서 JSON (원본 미변경)
 *     diff:           SectionDiff|null,  // before/after 텍스트 diff
 *     appliedChanges: AppliedChange[],   // 반영된 변경 목록
 *     skippedChanges: SkippedChange[],   // 반영하지 못한 변경 (사유 포함)
 *     section:        string,            // 수정 대상 섹션
 *     evidence:       string[],          // 근거 목록
 *     confidence:     number,            // 변경 신뢰도 (0.0–1.0)
 *   }
 *
 *   ValidationResult — {
 *     valid:    boolean,
 *     errors:   string[],
 *   }
 *
 * Pure module — no I/O, no fetch, no side effects.
 * 외부 I/O 는 호출하는 route handler 에서 담당한다.
 */

import { applyChatChangesToResume, buildSectionDiff } from "./resumeChatApplySections.mjs";

// ── 공개 API ──────────────────────────────────────────────────────────────────

/**
 * 대화 컨텍스트의 구체화된 내용으로 이력서 JSON 을 수정한 새 객체를 생성한다.
 *
 * 입력 경로:
 *   - options.suggestions 가 있으면 구조화된 제안을 직접 사용
 *   - options.history 가 있으면 대화에서 구체화된 내용을 추출
 *   - 둘 다 있으면 suggestions 를 우선 사용
 *
 * @param {object} resumeDoc   — 현재 이력서 JSON (원본; 수정하지 않음)
 * @param {string} section     — 수정 대상 섹션 ('experience'|'skills'|'summary'|'projects'|'education'|'strengths')
 * @param {Object} options
 * @param {object[]} [options.suggestions]    — RefinedSuggestion[] (refineSectionWithChat 결과)
 * @param {{ role: string, content: string }[]} [options.history] — 대화 히스토리
 * @param {string[]} [options.evidenceCited]  — 인용된 근거 텍스트
 * @param {string}   [options.userMessage]    — 사용자 요청 원문 (맥락용)
 * @returns {ModifiedResumeResult}
 */
export function generateModifiedResume(resumeDoc, section, options = {}) {
  if (!resumeDoc || typeof resumeDoc !== "object") {
    throw new Error("resumeDoc 은 유효한 객체여야 합니다.");
  }
  if (!section || typeof section !== "string") {
    throw new Error("section 은 유효한 문자열이어야 합니다.");
  }

  const { suggestions, history, evidenceCited = [], userMessage } = options;

  // ── 1. 제안 수집 ─────────────────────────────────────────────────────────────
  let resolvedSuggestions = [];
  let extractionSource = "none";

  if (Array.isArray(suggestions) && suggestions.length > 0) {
    resolvedSuggestions = suggestions;
    extractionSource = "suggestions";
  } else if (Array.isArray(history) && history.length > 0) {
    resolvedSuggestions = extractRefinedContentFromHistory(history, section);
    extractionSource = "history";
  }

  // 제안이 없으면 원본 그대로 반환
  if (resolvedSuggestions.length === 0) {
    return {
      updatedDoc: resumeDoc,
      diff: null,
      appliedChanges: [],
      skippedChanges: [],
      section,
      evidence: [],
      confidence: 0,
    };
  }

  // ── 2. RefinedSuggestion → ProposedChange 변환 ─────────────────────────────
  const changes = convertSuggestionsToChanges(resolvedSuggestions, section);

  if (changes.length === 0) {
    return {
      updatedDoc: resumeDoc,
      diff: null,
      appliedChanges: [],
      skippedChanges: resolvedSuggestions.map((s) => ({
        content: s.content ?? "",
        reason: "변환할 수 있는 유효한 변경 내용이 없습니다.",
      })),
      section,
      evidence: evidenceCited,
      confidence: 0,
    };
  }

  // ── 3. ApplyIntentResult 구성 + 이력서 수정 ─────────────────────────────────
  const applyIntentResult = {
    detected: true,
    section,
    changes,
    confidence: _computeModificationConfidence(resolvedSuggestions, extractionSource),
    ambiguous: false,
    clarificationNeeded: null,
    sourceMessageIndex: -1,
  };

  const applyResult = applyChatChangesToResume(resumeDoc, applyIntentResult);

  // ── 4. 근거 통합 ────────────────────────────────────────────────────────────
  const allEvidence = _collectEvidence(resolvedSuggestions, evidenceCited, applyResult.diff);

  // ── 5. 검증 ─────────────────────────────────────────────────────────────────
  if (applyResult.appliedChanges.length > 0) {
    const validation = validateModifiedSection(applyResult.updatedDoc, section, resumeDoc);
    if (!validation.valid) {
      // 검증 실패 시 원본 반환 + 사유 보고
      return {
        updatedDoc: resumeDoc,
        diff: null,
        appliedChanges: [],
        skippedChanges: applyResult.appliedChanges.map((c) => ({
          content: c.content,
          reason: `검증 실패: ${validation.errors.join("; ")}`,
        })),
        section,
        evidence: allEvidence,
        confidence: 0,
      };
    }
  }

  return {
    updatedDoc: applyResult.updatedDoc,
    diff: applyResult.diff,
    appliedChanges: applyResult.appliedChanges,
    skippedChanges: applyResult.skippedChanges,
    section,
    evidence: allEvidence,
    confidence: applyIntentResult.confidence,
  };
}

/**
 * RefinedSuggestion[] 를 ProposedChange[] 형식으로 변환한다.
 *
 * 변환 규칙:
 *   type: "bullet"  → ProposedChange { type: "bullet", content, context }
 *   type: "summary" → ProposedChange { type: "text",   content, context }
 *   type: "skill"   → ProposedChange { type: "bullet", content, context }
 *   기타             → ProposedChange { type: "bullet", content, context }
 *
 * @param {object[]} suggestions  — RefinedSuggestion[]
 * @param {string}   section      — 대상 섹션 (context 분류에 사용)
 * @returns {object[]}  — ProposedChange[]
 */
export function convertSuggestionsToChanges(suggestions, section) {
  if (!Array.isArray(suggestions)) return [];

  return suggestions
    .filter((s) => s && typeof s.content === "string" && s.content.trim().length > 0)
    .map((s) => {
      const content = s.content.trim();
      const context = _buildChangeContext(s, section);

      // summary 섹션의 텍스트 타입은 교체용이므로 type: 'text'
      if (s.type === "summary" || (section === "summary" && s.type !== "bullet")) {
        return { type: "text", content, context };
      }

      // skill 타입은 기술 스택으로 분류 힌트가 필요할 수 있다
      if (s.type === "skill") {
        const skillContext = _buildSkillContext(s, context);
        return { type: "bullet", content, context: skillContext };
      }

      // 기본: bullet 타입
      return { type: "bullet", content, context };
    });
}

/**
 * 대화 히스토리에서 가장 최근 어시스턴트 메시지의 구체화된 내용을
 * RefinedSuggestion[] 형태로 추출한다.
 *
 * 추출 전략:
 *   1. 가장 최근 어시스턴트 메시지를 역순으로 탐색
 *   2. 메시지 내에서 구조화된 콘텐츠 블록을 감지:
 *      - "## 제안" / "## 개선 사항" / "## 어필 포인트" 섹션
 *      - 번호/불릿 목록 (1. / - / • / * )
 *      - **굵은 제목** + 설명 패턴
 *   3. 감지된 항목을 RefinedSuggestion 으로 변환
 *
 * @param {{ role: string, content: string }[]} history
 * @param {string} section  — 대상 섹션
 * @returns {object[]}  — RefinedSuggestion[]
 */
export function extractRefinedContentFromHistory(history, section) {
  if (!Array.isArray(history) || history.length === 0) return [];

  // 가장 최근 어시스턴트 메시지 찾기
  let assistantContent = "";
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === "assistant" && history[i]?.content?.trim()) {
      assistantContent = history[i].content;
      break;
    }
  }
  if (!assistantContent) return [];

  return _parseRefinedSuggestions(assistantContent, section);
}

/**
 * 수정된 이력서의 특정 섹션이 스키마를 위반하지 않는지 검증한다.
 *
 * 검증 항목:
 *   - 필수 필드 존재 여부
 *   - 배열 타입 올바른지
 *   - 문자열 길이 제한 (지나치게 긴 불릿/요약 방지)
 *   - 빈 배열이 아닌지 (기존에 있던 항목이 사라지지 않았는지)
 *
 * @param {object} updatedDoc   — 수정된 이력서
 * @param {string} section      — 수정된 섹션
 * @param {object} originalDoc  — 원본 이력서 (비교용)
 * @returns {ValidationResult}
 */
export function validateModifiedSection(updatedDoc, section, originalDoc) {
  const errors = [];

  switch (section) {
    case "summary":
      if (typeof updatedDoc.summary !== "string") {
        errors.push("summary 는 문자열이어야 합니다.");
      } else if (updatedDoc.summary.length > 2000) {
        errors.push("summary 가 2000자를 초과합니다.");
      }
      break;

    case "skills": {
      const sk = updatedDoc.skills;
      if (!sk || typeof sk !== "object") {
        errors.push("skills 는 객체여야 합니다.");
      } else {
        if (!Array.isArray(sk.technical)) errors.push("skills.technical 는 배열이어야 합니다.");
        if (!Array.isArray(sk.languages)) errors.push("skills.languages 는 배열이어야 합니다.");
        if (!Array.isArray(sk.tools)) errors.push("skills.tools 는 배열이어야 합니다.");
        // 기존 스킬이 사라지지 않았는지 확인
        const origTotal =
          (originalDoc.skills?.technical?.length ?? 0) +
          (originalDoc.skills?.languages?.length ?? 0) +
          (originalDoc.skills?.tools?.length ?? 0);
        const newTotal =
          (sk.technical?.length ?? 0) +
          (sk.languages?.length ?? 0) +
          (sk.tools?.length ?? 0);
        if (origTotal > 0 && newTotal < origTotal) {
          errors.push("skills 항목이 줄어들었습니다. 기존 스킬이 삭제되었을 수 있습니다.");
        }
      }
      break;
    }

    case "experience":
    case "projects":
    case "education":
      if (!Array.isArray(updatedDoc[section])) {
        errors.push(`${section} 는 배열이어야 합니다.`);
      } else {
        const origLen = originalDoc[section]?.length ?? 0;
        if (origLen > 0 && updatedDoc[section].length < origLen) {
          errors.push(`${section} 항목 수가 줄어들었습니다.`);
        }
        // 불릿 길이 검증 (500자 초과 방지)
        for (const item of updatedDoc[section]) {
          if (Array.isArray(item.bullets)) {
            for (const bullet of item.bullets) {
              if (typeof bullet === "string" && bullet.length > 500) {
                errors.push(`${section} 의 불릿이 500자를 초과합니다: "${bullet.slice(0, 50)}..."`);
              }
            }
          }
        }
      }
      break;

    case "strengths":
      if (!Array.isArray(updatedDoc.strength_keywords)) {
        // strength_keywords 가 아직 없을 수 있으므로 에러가 아니라 경고 수준
        // (빈 배열로 초기화되었을 수도 있음)
      } else {
        if (updatedDoc.strength_keywords.length > 50) {
          errors.push("strength_keywords 가 50개를 초과합니다.");
        }
        for (const kw of updatedDoc.strength_keywords) {
          if (typeof kw === "string" && kw.length > 60) {
            errors.push(`강점 키워드가 60자를 초과합니다: "${kw.slice(0, 30)}..."`);
          }
        }
      }
      break;

    default:
      // 알 수 없는 섹션은 검증하지 않음 (applyChatChangesToResume 에서 이미 skipped 처리됨)
      break;
  }

  return { valid: errors.length === 0, errors };
}

/**
 * 여러 제안을 섹션별로 그룹핑하여 한번에 적용한다.
 * 하나의 대화 턴에서 여러 섹션에 걸친 제안이 나올 때 사용한다.
 *
 * @param {object} resumeDoc       — 현재 이력서 JSON
 * @param {Object<string, object[]>} sectionSuggestions  — { section: RefinedSuggestion[] }
 * @param {Object} [options]
 * @param {string[]} [options.evidenceCited]
 * @returns {Object<string, ModifiedResumeResult>}  — 섹션별 수정 결과
 */
export function generateMultiSectionModifications(resumeDoc, sectionSuggestions, options = {}) {
  if (!resumeDoc || typeof resumeDoc !== "object") {
    throw new Error("resumeDoc 은 유효한 객체여야 합니다.");
  }
  if (!sectionSuggestions || typeof sectionSuggestions !== "object") {
    return {};
  }

  const results = {};
  // 한 섹션씩 순차적으로 적용 (constraint: 한 번에 한 섹션씩)
  for (const [section, suggestions] of Object.entries(sectionSuggestions)) {
    if (!Array.isArray(suggestions) || suggestions.length === 0) continue;

    results[section] = generateModifiedResume(resumeDoc, section, {
      suggestions,
      evidenceCited: options.evidenceCited,
    });
  }

  return results;
}

// ── 내부 유틸 ─────────────────────────────────────────────────────────────────

/**
 * RefinedSuggestion 에서 ProposedChange 의 context 를 생성한다.
 *
 * @param {object} suggestion  — RefinedSuggestion
 * @param {string} section     — 대상 섹션
 * @returns {string|undefined}
 */
function _buildChangeContext(suggestion, section) {
  // company 필드가 있으면 경력 대상 힌트로 사용
  if (suggestion.company) return suggestion.company;

  // evidence 배열에서 가장 관련 있는 출처 텍스트를 context 로 사용
  if (Array.isArray(suggestion.evidence) && suggestion.evidence.length > 0) {
    // 첫 번째 근거를 context 로 사용 (간결성을 위해 100자 제한)
    const firstEvidence = suggestion.evidence[0];
    if (typeof firstEvidence === "string" && firstEvidence.length > 0) {
      return firstEvidence.length > 100
        ? firstEvidence.slice(0, 100) + "…"
        : firstEvidence;
    }
  }

  return undefined;
}

/**
 * skill 타입 제안의 context 에 분류 힌트를 추가한다.
 *
 * @param {object} suggestion
 * @param {string|undefined} baseContext
 * @returns {string|undefined}
 */
function _buildSkillContext(suggestion, baseContext) {
  // 제안 자체에 카테고리 힌트가 있으면 사용
  if (suggestion.category) {
    const cat = suggestion.category.toLowerCase();
    if (cat.includes("language") || cat.includes("언어")) return "프로그래밍 언어";
    if (cat.includes("tool") || cat.includes("도구")) return "도구";
  }
  return baseContext;
}

/**
 * 어시스턴트 응답 텍스트에서 구체화된 제안을 파싱한다.
 *
 * @param {string} text       — 어시스턴트 메시지 텍스트
 * @param {string} section    — 대상 섹션
 * @returns {object[]}  — RefinedSuggestion[]
 */
function _parseRefinedSuggestions(text, section) {
  if (!text || typeof text !== "string") return [];

  const suggestions = [];

  // 코드 블록 제거
  const cleaned = text.replace(/```[\s\S]*?```/g, "");
  const lines = cleaned.split("\n");

  let currentContext = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) {
      currentContext = null;
      continue;
    }

    // 섹션 헤더 감지 (## 또는 **제목**)
    const headerMatch = line.match(/^#{1,3}\s+(.+)/) || line.match(/^\*\*(.+?)\*\*\s*$/);
    if (headerMatch) {
      currentContext = headerMatch[1].trim();
      continue;
    }

    // 번호/불릿 목록 라인
    const bulletMatch = line.match(/^(?:\s*(?:[-•*]|\d+[.)]\s))\s*(.+)$/);
    if (bulletMatch) {
      const content = bulletMatch[1].trim();
      // **굵은 텍스트**: 설명 패턴
      const boldDescMatch = content.match(/^\*\*(.+?)\*\*[:\s]*(.*)$/);

      if (boldDescMatch) {
        const title = boldDescMatch[1].trim();
        const desc = boldDescMatch[2].trim();
        const fullContent = desc ? `${title}: ${desc}` : title;

        if (fullContent.length >= 5) {
          suggestions.push({
            type: _inferSuggestionType(section),
            content: fullContent,
            evidence: currentContext ? [currentContext] : [],
            company: _inferCompanyFromContext(currentContext),
          });
        }
      } else if (content.length >= 5) {
        suggestions.push({
          type: _inferSuggestionType(section),
          content,
          evidence: currentContext ? [currentContext] : [],
          company: _inferCompanyFromContext(currentContext),
        });
      }
      continue;
    }

    // 긴 단독 텍스트 (summary 후보)
    if (section === "summary" && line.length >= 20 && !line.startsWith("#")) {
      suggestions.push({
        type: "summary",
        content: line,
        evidence: currentContext ? [currentContext] : [],
      });
    }
  }

  // 아무것도 파싱되지 않고 summary 섹션이면 전체 텍스트를 하나의 제안으로
  if (suggestions.length === 0 && section === "summary") {
    const plainText = text.trim();
    if (plainText.length >= 10) {
      suggestions.push({
        type: "summary",
        content: plainText,
        evidence: [],
      });
    }
  }

  return suggestions;
}

/**
 * 섹션에 따른 기본 제안 타입을 결정한다.
 *
 * @param {string} section
 * @returns {"bullet"|"summary"|"skill"}
 */
function _inferSuggestionType(section) {
  if (section === "summary") return "summary";
  if (section === "skills") return "skill";
  return "bullet";
}

/**
 * context 문자열에서 회사명을 유추한다.
 *
 * @param {string|null} context
 * @returns {string|undefined}
 */
function _inferCompanyFromContext(context) {
  if (!context) return undefined;

  // "(주)", "Inc.", "Corp.", "LLC" 등이 포함되어 있으면 회사명으로 간주
  if (/\(주\)|inc\.|corp\.|llc|ltd\.|주식회사|co\./i.test(context)) {
    return context;
  }

  // 경력/경험 관련 헤더인 경우 회사명이 아님
  if (/경력|경험|어필|포인트|성과|기여|역할/i.test(context)) {
    return undefined;
  }

  return undefined;
}

/**
 * 변경 신뢰도를 계산한다.
 *
 * @param {object[]} suggestions     — 제안 목록
 * @param {string}   extractionSource  — "suggestions" | "history"
 * @returns {number}  — 0.0–1.0
 */
function _computeModificationConfidence(suggestions, extractionSource) {
  let confidence = 0.5;

  // 구조화된 제안이 직접 전달된 경우 신뢰도 +0.3
  if (extractionSource === "suggestions") confidence += 0.3;
  // 대화에서 추출한 경우 +0.1 (비구조화 텍스트이므로 낮음)
  else if (extractionSource === "history") confidence += 0.1;

  // 근거가 있는 제안이 있으면 신뢰도 +0.15
  const hasEvidence = suggestions.some(
    (s) => Array.isArray(s.evidence) && s.evidence.length > 0
  );
  if (hasEvidence) confidence += 0.15;

  // 제안 수가 적절한 범위(1–5)이면 +0.05
  if (suggestions.length >= 1 && suggestions.length <= 5) confidence += 0.05;

  return Math.min(1.0, confidence);
}

/**
 * 제안, 인용 근거, diff 에서 모든 근거를 통합한다.
 *
 * @param {object[]}   suggestions
 * @param {string[]}   evidenceCited
 * @param {object|null} diff
 * @returns {string[]}
 */
function _collectEvidence(suggestions, evidenceCited, diff) {
  const evidenceSet = new Set();

  // 인용 근거
  for (const e of evidenceCited) {
    if (typeof e === "string" && e.trim()) evidenceSet.add(e.trim());
  }

  // 제안 내 근거
  for (const s of suggestions) {
    if (Array.isArray(s.evidence)) {
      for (const e of s.evidence) {
        if (typeof e === "string" && e.trim()) evidenceSet.add(e.trim());
      }
    }
  }

  // diff 내 근거
  if (diff && Array.isArray(diff.evidence)) {
    for (const e of diff.evidence) {
      if (typeof e === "string" && e.trim()) evidenceSet.add(e.trim());
    }
  }

  return [...evidenceSet];
}
