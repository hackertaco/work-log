/**
 * resumeChatApplySections.mjs
 *
 * Sub-AC 5-2: 파싱된 변경 내용을 기반으로 이력서 JSON의 해당 섹션을 실제로 수정하고
 * 업데이트된 JSON 객체를 생성하는 로직.
 *
 * Pure module — no I/O, no external imports, no side effects.
 *
 * ─── 주요 함수 ─────────────────────────────────────────────────────────────────
 *
 *   applyChatChangesToResume(resumeDoc, applyIntentResult)
 *     ApplyIntentResult 의 section + changes 를 이력서 문서에 적용한다.
 *     → ApplySectionsResult
 *
 *   buildSectionDiff(resumeDoc, section, changes)
 *     변경 적용 전후의 섹션 텍스트를 diff 객체로 반환한다.
 *     → SectionDiff | null
 *
 * ─── 타입 ─────────────────────────────────────────────────────────────────────
 *
 *   ApplySectionsResult — {
 *     updatedDoc:     object,            // 업데이트된 이력서 문서 (불변 — 원본 미변경)
 *     diff:           SectionDiff|null,  // diff 표시용 before/after 텍스트
 *     appliedChanges: AppliedChange[],   // 실제로 반영된 변경 목록
 *     skippedChanges: SkippedChange[],   // 반영하지 못한 변경 목록 (사유 포함)
 *   }
 *
 *   SectionDiff — {
 *     section:  string,    // 수정된 섹션 이름
 *     before:   string,    // 수정 전 텍스트 (사람이 읽을 수 있는 형식)
 *     after:    string,    // 수정 후 텍스트 (PATCH /api/resume/section 의 content 로 사용 가능)
 *     evidence: string[],  // 근거 목록 (변경 내용의 context 필드에서 추출)
 *   }
 *
 *   AppliedChange — {
 *     section:    string,           // 수정된 섹션 이름
 *     type:       string,           // 변경 종류 ('append_bullet' | 'add_skill' | 'replace_summary' | …)
 *     content:    string,           // 반영된 텍스트
 *     targetHint: string|undefined, // 적용 대상 힌트 (회사명, 프로젝트명 등)
 *   }
 *
 *   SkippedChange — {
 *     content: string,  // 반영하지 못한 텍스트
 *     reason:  string,  // 사유 (중복, 대상 없음 등)
 *   }
 */

// ── 공개 API ──────────────────────────────────────────────────────────────────

/**
 * ApplyIntentResult 의 section + changes 를 이력서 문서에 적용한다.
 *
 * 섹션별 적용 전략:
 *   summary    — 변경 내용 전체를 하나의 텍스트로 합쳐 요약을 교체한다
 *   skills     — 각 content 를 기술 스택으로 파싱해 technical 목록에 병합(중복 제거)한다
 *   experience — 각 content 를 가장 최근 경력 항목(또는 context 로 지정한 항목)의 불릿으로 추가한다
 *   projects   — 각 content 를 가장 최근 프로젝트(또는 context 로 지정한 항목)의 불릿으로 추가한다
 *   education  — 각 content 를 가장 최근 학력 항목의 불릿으로 추가한다
 *
 * @param {object} resumeDoc         — ResumeLivingDocument (원본; 수정하지 않음)
 * @param {object} applyIntentResult — ApplyIntentResult (resumeChatApplyIntent.mjs)
 * @returns {ApplySectionsResult}
 */
export function applyChatChangesToResume(resumeDoc, applyIntentResult) {
  if (!resumeDoc || typeof resumeDoc !== 'object') {
    throw new Error('resumeDoc 은 객체여야 합니다.');
  }

  const { section, changes } = applyIntentResult ?? {};

  // 섹션이 없거나 변경 내용이 없으면 원본 그대로 반환
  if (!section) {
    return {
      updatedDoc: resumeDoc,
      diff: null,
      appliedChanges: [],
      skippedChanges: Array.isArray(changes)
        ? changes.map((c) => ({ content: c.content ?? '', reason: '대상 섹션이 지정되지 않았습니다.' }))
        : [],
    };
  }

  const validChanges = Array.isArray(changes) ? changes.filter((c) => c.content?.trim()) : [];
  if (validChanges.length === 0) {
    return {
      updatedDoc: resumeDoc,
      diff: null,
      appliedChanges: [],
      skippedChanges: [],
    };
  }

  // 원본 문서를 깊게 복사하여 불변성을 보장한다
  const doc = _deepCloneDoc(resumeDoc);

  const appliedChanges = [];
  const skippedChanges = [];

  // 섹션별 적용 함수 호출 (before 스냅샷은 diff 용으로 별도 캡처)
  const beforeSnapshot = _captureSectionSnapshot(doc, section);

  switch (section) {
    case 'summary':
      _applySummaryChanges(doc, validChanges, appliedChanges, skippedChanges);
      break;
    case 'skills':
      _applySkillsChanges(doc, validChanges, appliedChanges, skippedChanges);
      break;
    case 'experience':
      _applyBulletChanges(doc, 'experience', validChanges, appliedChanges, skippedChanges);
      break;
    case 'projects':
      _applyBulletChanges(doc, 'projects', validChanges, appliedChanges, skippedChanges);
      break;
    case 'education':
      _applyBulletChanges(doc, 'education', validChanges, appliedChanges, skippedChanges);
      break;
    // Sub-AC 8-1: 강점(Strengths) 섹션 — strength_keywords 배열 업데이트
    case 'strengths':
      _applyStrengthsKeywordsChanges(doc, validChanges, appliedChanges, skippedChanges);
      break;
    default:
      skippedChanges.push(
        ...validChanges.map((c) => ({ content: c.content, reason: `지원하지 않는 섹션: ${section}` }))
      );
  }

  // diff 생성 (변경이 실제로 발생한 경우에만)
  const diff =
    appliedChanges.length > 0
      ? _buildDiff(section, beforeSnapshot, doc, validChanges)
      : null;

  return { updatedDoc: doc, diff, appliedChanges, skippedChanges };
}

/**
 * 변경 적용 전후의 섹션 텍스트를 diff 객체로 반환한다.
 *
 * 실제로 resume doc 을 수정하지 않고 diff 만 미리 계산할 때 사용한다.
 *
 * @param {object} resumeDoc  — ResumeLivingDocument
 * @param {string} section    — 섹션 이름
 * @param {object[]} changes  — ProposedChange[]
 * @returns {SectionDiff|null}
 */
export function buildSectionDiff(resumeDoc, section, changes) {
  if (!resumeDoc || !section || !Array.isArray(changes) || changes.length === 0) {
    return null;
  }
  const result = applyChatChangesToResume(resumeDoc, { section, changes });
  return result.diff;
}

// ── 섹션별 적용 함수 ─────────────────────────────────────────────────────────

/**
 * summary 섹션 변경 적용.
 * 변경 내용을 하나의 텍스트로 합쳐 doc.summary 를 교체한다.
 *
 * @param {object} doc
 * @param {object[]} changes  — ProposedChange[]
 * @param {object[]} appliedChanges
 * @param {object[]} skippedChanges
 */
function _applySummaryChanges(doc, changes, appliedChanges, skippedChanges) {
  const parts = changes.map((c) => c.content.trim()).filter(Boolean);
  if (parts.length === 0) return;

  // 여러 변경이 있으면 줄바꿈으로 연결한다
  const newSummary = parts.length === 1 ? parts[0] : parts.join('\n');

  doc.summary = newSummary;
  doc._sources = { ...(doc._sources ?? {}), summary: 'user_approved' };

  appliedChanges.push({
    section: 'summary',
    type: 'replace_summary',
    content: newSummary,
    targetHint: undefined,
  });
}

/**
 * skills 섹션 변경 적용.
 * 각 content 를 기술 스택으로 파싱해 skills.technical 목록에 병합한다.
 *
 * 중복(대소문자 무시) 항목은 skippedChanges 에 기록한다.
 * context 힌트에 "language" / "언어" 키워드가 있으면 languages 로, "tool" / "도구" 가 있으면
 * tools 로 분류한다 (기본: technical).
 *
 * @param {object} doc
 * @param {object[]} changes
 * @param {object[]} appliedChanges
 * @param {object[]} skippedChanges
 */
function _applySkillsChanges(doc, changes, appliedChanges, skippedChanges) {
  const skills = {
    technical: [...(doc.skills?.technical ?? [])],
    languages: [...(doc.skills?.languages ?? [])],
    tools: [...(doc.skills?.tools ?? [])],
  };

  // 기존 기술 스택 소문자 집합 (중복 검사용)
  const existingLower = new Set(
    [...skills.technical, ...skills.languages, ...skills.tools].map((s) =>
      String(s).toLowerCase().trim()
    )
  );

  for (const change of changes) {
    // 쉼표·중점(·)·슬래시로 구분된 여러 기술을 지원한다
    const items = change.content
      .split(/[,·\/]/)
      .map((s) => s.trim())
      .filter(Boolean);

    for (const item of items) {
      const itemLower = item.toLowerCase();
      if (existingLower.has(itemLower)) {
        skippedChanges.push({ content: item, reason: '이미 존재하는 기술 스택입니다.' });
        continue;
      }

      // context 로 서브 배열 분류
      const ctx = (change.context ?? '').toLowerCase();
      const target = _classifySkillTarget(ctx);

      skills[target].push(item);
      existingLower.add(itemLower);

      appliedChanges.push({
        section: 'skills',
        type: `add_${target}_skill`,
        content: item,
        targetHint: target,
      });
    }
  }

  doc.skills = skills;
  if (appliedChanges.some((c) => c.section === 'skills')) {
    doc._sources = { ...(doc._sources ?? {}), skills: 'user_approved' };
  }
}

/**
 * experience / projects / education 섹션에 불릿을 추가한다.
 *
 * 대상 항목 결정 우선순위:
 *   1. ProposedChange.context 에서 회사명·프로젝트명·기관명을 유추하여 일치하는 항목을 찾는다.
 *   2. 일치 항목이 없으면 가장 최근(index 0) 항목에 추가한다.
 *
 * 중복 불릿(대소문자 무시)은 skippedChanges 에 기록한다.
 *
 * @param {object} doc
 * @param {'experience'|'projects'|'education'} section
 * @param {object[]} changes
 * @param {object[]} appliedChanges
 * @param {object[]} skippedChanges
 */
function _applyBulletChanges(doc, section, changes, appliedChanges, skippedChanges) {
  const items = doc[section];
  if (!Array.isArray(items) || items.length === 0) {
    skippedChanges.push(
      ...changes.map((c) => ({
        content: c.content,
        reason: `이력서에 ${_sectionLabel(section)} 항목이 없습니다.`,
      }))
    );
    return;
  }

  // 섹션 전체를 얕게 복사하고 bullets 배열도 복사한다
  const updatedItems = items.map((item) => ({ ...item, bullets: [...(item.bullets ?? [])] }));

  for (const change of changes) {
    const content = change.content.trim();
    if (!content) continue;

    // context 힌트로 대상 항목 탐색
    const targetIdx = _findTargetItemIndex(updatedItems, section, change.context);
    const target = updatedItems[targetIdx];

    // 중복 불릿 검사
    const contentLower = content.toLowerCase();
    if (target.bullets.some((b) => String(b).trim().toLowerCase() === contentLower)) {
      skippedChanges.push({ content, reason: '이미 존재하는 불릿입니다.' });
      continue;
    }

    target.bullets.push(content);
    target._source = 'user_approved';

    const targetHint = _getItemLabel(target, section, targetIdx);
    appliedChanges.push({
      section,
      type: 'append_bullet',
      content,
      targetHint,
    });
  }

  doc[section] = updatedItems;
}

// ── Diff 빌더 ────────────────────────────────────────────────────────────────

/**
 * 변경 전후의 섹션 상태를 사람이 읽을 수 있는 before/after 텍스트 diff 로 반환한다.
 *
 * after 텍스트는 PATCH /api/resume/section 의 content 파라미터로 바로 사용할 수 있는 형식이다.
 *
 * @param {string} section
 * @param {string} beforeSnapshot   — 변경 전 섹션 텍스트
 * @param {object} updatedDoc       — 변경 후 문서
 * @param {object[]} changes        — 원본 ProposedChange[] (evidence 추출용)
 * @returns {SectionDiff}
 */
function _buildDiff(section, beforeSnapshot, updatedDoc, changes) {
  const after = _captureSectionSnapshot(updatedDoc, section);
  const evidence = changes
    .map((c) => c.context)
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i); // unique

  return {
    section,
    before: beforeSnapshot,
    after,
    evidence,
  };
}

// ── 스냅샷 직렬화 ─────────────────────────────────────────────────────────────

/**
 * 이력서 문서의 특정 섹션을 사람이 읽을 수 있는 텍스트로 직렬화한다.
 *
 * 직렬화 형식:
 *   summary    — 그대로 문자열
 *   skills     — "- 기술명" 불릿 형식 (PATCH /api/resume/section 의 content 와 호환)
 *   experience — 가장 최근(index 0) 항목의 불릿을 "- 텍스트" 형식으로 나열
 *   projects   — 가장 최근(index 0) 프로젝트의 불릿
 *   education  — 가장 최근(index 0) 학력 항목의 불릿
 *
 * 주의: skills 는 "technical: A, B" 형식 대신 "- A\n- B" 형식을 사용한다.
 *       PATCH /api/resume/section 의 _parseSkillLines 가 "- skill" 형식으로 파싱하므로
 *       카테고리 접두사가 포함된 형식은 "technical: TypeScript" 를 하나의 기술명으로
 *       잘못 해석하는 문제를 피하기 위해 불릿 형식을 사용한다.
 *
 * @param {object} doc
 * @param {string} section
 * @returns {string}
 */
function _captureSectionSnapshot(doc, section) {
  switch (section) {
    case 'summary':
      return typeof doc.summary === 'string' ? doc.summary : '';

    case 'skills': {
      // "- skill" 형식 — _parseSkillLines 에서 올바르게 파싱됨
      const sk = doc.skills ?? {};
      const all = [
        ...(Array.isArray(sk.technical) ? sk.technical : []),
        ...(Array.isArray(sk.languages) ? sk.languages : []),
        ...(Array.isArray(sk.tools) ? sk.tools : []),
      ];
      return all.map((s) => `- ${s}`).join('\n');
    }

    case 'experience':
    case 'projects':
    case 'education': {
      const items = doc[section];
      if (!Array.isArray(items) || items.length === 0) return '';
      // 가장 최근 항목의 불릿만 스냅샷에 포함한다
      const first = items[0];
      const label = _getItemLabel(first, section, 0);
      const bullets = Array.isArray(first.bullets)
        ? first.bullets.map((b) => `- ${b}`).join('\n')
        : '';
      return label ? `${label}\n${bullets}` : bullets;
    }

    // Sub-AC 8-1: 강점(Strengths) 섹션 — strength_keywords 배열을 불릿 형식으로 직렬화
    case 'strengths': {
      const kw = Array.isArray(doc.strength_keywords) ? doc.strength_keywords : [];
      return kw.map((k) => `- ${k}`).join('\n');
    }

    default:
      return '';
  }
}

/**
 * strengths 섹션 변경 적용 (Sub-AC 8-1).
 * 각 content 를 키워드로 파싱해 doc.strength_keywords 에 병합한다 (중복 제거).
 *
 * 쉼표·중점(·)·슬래시·줄바꿈으로 구분된 여러 키워드를 지원한다.
 * 기존 키워드와 중복(대소문자 무시)되면 skippedChanges 에 기록한다.
 *
 * @param {object} doc
 * @param {object[]} changes  — ProposedChange[]
 * @param {object[]} appliedChanges
 * @param {object[]} skippedChanges
 */
function _applyStrengthsKeywordsChanges(doc, changes, appliedChanges, skippedChanges) {
  // 기존 strength_keywords 배열을 복사 (없으면 빈 배열)
  const existingKw = Array.isArray(doc.strength_keywords) ? [...doc.strength_keywords] : [];

  // 기존 키워드 소문자 집합 (중복 검사용)
  const existingLower = new Set(existingKw.map((k) => String(k).toLowerCase().trim()));

  for (const change of changes) {
    // 쉼표·중점(·)·슬래시·줄바꿈으로 구분된 여러 키워드를 지원
    const items = change.content
      .split(/[,·\/\n]/)
      .map((s) => s.replace(/^[-•*]\s*/, '').trim()) // 불릿 접두사 제거
      .filter(Boolean);

    for (const item of items) {
      const itemLower = item.toLowerCase();

      // 50자 이상 키워드는 제외 (StrengthKeywordsDocument 규격)
      if (item.length > 50) {
        skippedChanges.push({ content: item, reason: '키워드가 너무 깁니다 (50자 이하).' });
        continue;
      }

      if (existingLower.has(itemLower)) {
        skippedChanges.push({ content: item, reason: '이미 존재하는 강점 키워드입니다.' });
        continue;
      }

      existingKw.push(item);
      existingLower.add(itemLower);

      appliedChanges.push({
        section: 'strengths',
        type: 'add_strength_keyword',
        content: item,
        targetHint: undefined,
      });
    }
  }

  // 최대 50개 제한 (StrengthKeywordsDocument 규격)
  doc.strength_keywords = existingKw.slice(0, 50);

  if (appliedChanges.some((c) => c.section === 'strengths')) {
    doc._sources = { ...(doc._sources ?? {}), strength_keywords: 'user_approved' };
  }
}

// ── 내부 유틸 ─────────────────────────────────────────────────────────────────

/**
 * 이력서 문서를 깊게 복사한다.
 * 순수 JSON 객체(함수 없음)를 가정하므로 JSON 직렬화/역직렬화를 사용한다.
 *
 * @param {object} doc
 * @returns {object}
 */
function _deepCloneDoc(doc) {
  return JSON.parse(JSON.stringify(doc));
}

/**
 * context 힌트 문자열에서 skills 서브 배열 이름을 결정한다.
 *
 * @param {string} ctxLower  — toLowerCase() 된 context
 * @returns {'technical'|'languages'|'tools'}
 */
function _classifySkillTarget(ctxLower) {
  if (/language|언어|프로그래밍\s*언어/.test(ctxLower)) return 'languages';
  if (/tool|도구|툴/.test(ctxLower)) return 'tools';
  return 'technical';
}

/**
 * section 내 항목 배열에서 context 힌트와 일치하는 항목의 인덱스를 반환한다.
 * 일치하지 않으면 0(가장 최근 항목)을 반환한다.
 *
 * @param {object[]} items        — 얕게 복사된 항목 배열
 * @param {string}   section      — 'experience' | 'projects' | 'education'
 * @param {string|undefined} context
 * @returns {number}
 */
function _findTargetItemIndex(items, section, context) {
  if (!context) return 0;

  const ctxNorm = context.toLowerCase().trim();

  const nameKey = section === 'experience'
    ? 'company'
    : section === 'projects'
      ? 'name'
      : 'institution';

  // 부분 문자열 포함 여부로 검색한다
  const idx = items.findIndex((item) => {
    const name = String(item[nameKey] ?? '').toLowerCase().trim();
    return name && (name.includes(ctxNorm) || ctxNorm.includes(name));
  });

  return idx === -1 ? 0 : idx;
}

/**
 * 항목의 표시 레이블(회사명, 프로젝트명, 기관명)을 반환한다.
 *
 * @param {object} item
 * @param {string} section
 * @param {number} idx
 * @returns {string}
 */
function _getItemLabel(item, section, idx) {
  if (section === 'experience') return item.company ?? `경력[${idx}]`;
  if (section === 'projects')   return item.name    ?? `프로젝트[${idx}]`;
  if (section === 'education')  return item.institution ?? `학력[${idx}]`;
  return `${section}[${idx}]`;
}

/**
 * 섹션 이름을 사람이 읽을 수 있는 레이블로 변환한다.
 *
 * @param {string} section
 * @returns {string}
 */
function _sectionLabel(section) {
  const labels = {
    experience: '경력/경험',
    projects: '프로젝트',
    education: '학력',
    skills: '기술',
    summary: '자기소개/요약',
    certifications: '자격증',
    strengths: '강점 키워드',
  };
  return labels[section] ?? section;
}
