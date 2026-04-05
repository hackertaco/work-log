/**
 * resumeJsonDiff — 프론트엔드용 이력서 JSON 전체 diff 유틸리티
 *
 * 두 개의 이력서 JSON 문서를 섹션·필드 단위로 비교해 UI 렌더링에
 * 최적화된 구조화 diff 배열을 반환한다.
 *
 * 백엔드 resumeDiff.mjs 와 같은 원칙을 따르되, 브라우저 환경에서
 * 동작하고 UI 렌더링에 필요한 레이블/타입 정보를 함께 포함한다.
 *
 * @module resumeJsonDiff
 */

// ─── 섹션 레이블 맵 ────────────────────────────────────────────────────────────

const SECTION_LABELS = {
  contact: '연락처',
  summary: '자기소개',
  experience: '경력',
  education: '학력',
  skills: '기술',
  projects: '프로젝트',
  certifications: '자격증',
  strength_keywords: '강점 키워드',
  display_axes: '커리어 테마',
};

const CONTACT_FIELD_LABELS = {
  name: '이름',
  email: '이메일',
  phone: '전화번호',
  location: '위치',
  website: '웹사이트',
  linkedin: 'LinkedIn',
};

const EXPERIENCE_FIELD_LABELS = {
  company: '회사명',
  title: '직함',
  start_date: '시작일',
  end_date: '종료일',
  location: '근무지',
  bullets: '업무 내용',
};

const EDUCATION_FIELD_LABELS = {
  institution: '학교명',
  degree: '학위',
  field: '전공',
  start_date: '시작일',
  end_date: '종료일',
  gpa: 'GPA',
};

const PROJECT_FIELD_LABELS = {
  name: '프로젝트명',
  description: '설명',
  url: 'URL',
  bullets: '주요 내용',
  tech_stack: '기술 스택',
};

const CERT_FIELD_LABELS = {
  name: '자격증명',
  issuer: '발급 기관',
  date: '취득일',
  expiry_date: '만료일',
  url: 'URL',
};

const SKILLS_CATEGORY_LABELS = {
  technical: '기술 스택',
  languages: '프로그래밍 언어',
  tools: '도구',
};

// ─── 공개 API ─────────────────────────────────────────────────────────────────

/**
 * 두 이력서 JSON 문서를 비교해 섹션별 diff 배열을 반환한다.
 *
 * 반환값은 UI 렌더링에 최적화된 구조로, 섹션 레이블·변경 타입·
 * 변경 내용이 포함된다. 변경이 없는 섹션은 포함되지 않는다.
 *
 * @param {object|null|undefined} original  원본 이력서 JSON
 * @param {object|null|undefined} modified  수정된 이력서 JSON
 * @returns {SectionDiff[]}  변경된 섹션의 diff 배열
 */
export function computeResumeJsonDiff(original, modified) {
  if (!original || typeof original !== 'object') return [];
  if (!modified || typeof modified !== 'object') return [];

  const results = [];

  // 연락처
  const contactDiff = _diffContact(original.contact, modified.contact);
  if (contactDiff) results.push(contactDiff);

  // 자기소개
  const summaryDiff = _diffSummary(original.summary, modified.summary);
  if (summaryDiff) results.push(summaryDiff);

  // 경력
  const expDiff = _diffArraySection(
    'experience',
    original.experience,
    modified.experience,
    _experienceKey,
    _diffExperienceItem,
    EXPERIENCE_FIELD_LABELS
  );
  if (expDiff) results.push(expDiff);

  // 학력
  const eduDiff = _diffArraySection(
    'education',
    original.education,
    modified.education,
    _educationKey,
    _diffEducationItem,
    EDUCATION_FIELD_LABELS
  );
  if (eduDiff) results.push(eduDiff);

  // 기술
  const skillsDiff = _diffSkills(original.skills, modified.skills);
  if (skillsDiff) results.push(skillsDiff);

  // 프로젝트
  const projDiff = _diffArraySection(
    'projects',
    original.projects,
    modified.projects,
    _projectKey,
    _diffProjectItem,
    PROJECT_FIELD_LABELS
  );
  if (projDiff) results.push(projDiff);

  // 자격증
  const certDiff = _diffArraySection(
    'certifications',
    original.certifications,
    modified.certifications,
    _certKey,
    _diffCertItem,
    CERT_FIELD_LABELS
  );
  if (certDiff) results.push(certDiff);

  // 강점 키워드
  const kwDiff = _diffStringArray(
    'strength_keywords',
    original.strength_keywords,
    modified.strength_keywords
  );
  if (kwDiff) results.push(kwDiff);

  return results;
}

/**
 * 전체 변경 수를 반환한다.
 * (추가 + 삭제 + 수정된 항목 수의 합)
 *
 * @param {SectionDiff[]} diffs
 * @returns {number}
 */
export function countTotalChanges(diffs) {
  let total = 0;
  for (const d of diffs) {
    if (d.type === 'scalar') {
      total += d.fields.length;
    } else if (d.type === 'text') {
      total += 1;
    } else if (d.type === 'array') {
      total += d.added.length + d.deleted.length + d.modified.length;
    } else if (d.type === 'skills') {
      for (const cat of ['technical', 'languages', 'tools']) {
        total += (d[cat].added?.length ?? 0) + (d[cat].deleted?.length ?? 0);
      }
    } else if (d.type === 'tags') {
      total += d.added.length + d.deleted.length;
    }
  }
  return total;
}

// ─── 섹션별 diff 함수 ─────────────────────────────────────────────────────────

/**
 * 연락처 섹션 diff
 * @returns {SectionDiff|null}
 */
function _diffContact(prev, next) {
  const p = prev && typeof prev === 'object' ? prev : {};
  const n = next && typeof next === 'object' ? next : {};

  const fields = ['name', 'email', 'phone', 'location', 'website', 'linkedin'];
  const changedFields = [];

  for (const field of fields) {
    const pVal = _nullableStr(p[field]);
    const nVal = _nullableStr(n[field]);
    if (pVal === nVal) continue;

    const label = CONTACT_FIELD_LABELS[field] ?? field;

    if (!pVal && nVal !== null) {
      changedFields.push({ field, label, type: 'added', before: null, after: nVal });
    } else if (pVal !== null && !nVal) {
      changedFields.push({ field, label, type: 'deleted', before: pVal, after: null });
    } else {
      changedFields.push({ field, label, type: 'modified', before: pVal, after: nVal });
    }
  }

  if (changedFields.length === 0) return null;

  return {
    key: 'contact',
    label: SECTION_LABELS.contact,
    type: 'scalar',
    fields: changedFields,
  };
}

/**
 * 자기소개 섹션 diff
 * @returns {SectionDiff|null}
 */
function _diffSummary(prev, next) {
  const p = typeof prev === 'string' ? prev.trim() : '';
  const n = typeof next === 'string' ? next.trim() : '';
  if (p === n) return null;

  return {
    key: 'summary',
    label: SECTION_LABELS.summary,
    type: 'text',
    before: p,
    after: n,
  };
}

/**
 * 배열 섹션 diff (경력, 학력, 프로젝트, 자격증)
 * @returns {SectionDiff|null}
 */
function _diffArraySection(key, prevArr, nextArr, keyFn, itemDiffFn, fieldLabels) {
  const prev = Array.isArray(prevArr) ? prevArr : [];
  const next = Array.isArray(nextArr) ? nextArr : [];

  const prevMap = new Map();
  for (const item of prev) {
    const k = keyFn(item);
    if (k) prevMap.set(k, item);
  }

  const nextMap = new Map();
  for (const item of next) {
    const k = keyFn(item);
    if (k) nextMap.set(k, item);
  }

  const added = [];
  const deleted = [];
  const modified = [];

  // 추가된 항목
  for (const [k, nItem] of nextMap) {
    if (!prevMap.has(k)) added.push(nItem);
  }

  // 수정된 항목
  for (const [k, pItem] of prevMap) {
    if (nextMap.has(k)) {
      const nItem = nextMap.get(k);
      const fieldChanges = itemDiffFn(pItem, nItem, fieldLabels);
      if (fieldChanges.length > 0) {
        modified.push({
          key: k,
          label: _itemLabel(nItem),
          before: pItem,
          after: nItem,
          fieldChanges,
          userOwned: pItem._source === 'user',
        });
      }
    }
  }

  // 삭제된 항목
  for (const [k, pItem] of prevMap) {
    if (!nextMap.has(k)) deleted.push(pItem);
  }

  if (added.length === 0 && deleted.length === 0 && modified.length === 0) return null;

  return {
    key,
    label: SECTION_LABELS[key] ?? key,
    type: 'array',
    added,
    deleted,
    modified,
  };
}

/**
 * 기술 섹션 diff
 * @returns {SectionDiff|null}
 */
function _diffSkills(prev, next) {
  const p = prev && typeof prev === 'object' ? prev : {};
  const n = next && typeof next === 'object' ? next : {};

  const categories = {};
  let hasChanges = false;

  for (const cat of ['technical', 'languages', 'tools']) {
    const diff = _rawStringArrayDiff(p[cat], n[cat]);
    categories[cat] = { ...diff, label: SKILLS_CATEGORY_LABELS[cat] };
    if (diff.added.length > 0 || diff.deleted.length > 0) hasChanges = true;
  }

  if (!hasChanges) return null;

  return {
    key: 'skills',
    label: SECTION_LABELS.skills,
    type: 'skills',
    ...categories,
  };
}

/**
 * 문자열 배열 섹션 diff (강점 키워드 등)
 * @returns {SectionDiff|null}
 */
function _diffStringArray(key, prev, next) {
  const diff = _rawStringArrayDiff(prev, next);
  if (diff.added.length === 0 && diff.deleted.length === 0) return null;

  return {
    key,
    label: SECTION_LABELS[key] ?? key,
    type: 'tags',
    added: diff.added,
    deleted: diff.deleted,
  };
}

// ─── 항목별 필드 diff ─────────────────────────────────────────────────────────

/**
 * 경력 항목 필드 diff
 * @returns {FieldChange[]}
 */
function _diffExperienceItem(prev, next, fieldLabels) {
  const changes = [];
  const scalarFields = ['company', 'title', 'start_date', 'end_date', 'location'];

  for (const field of scalarFields) {
    const pVal = _nullableStr(prev[field]);
    const nVal = _nullableStr(next[field]);
    if (pVal !== nVal) {
      changes.push({
        field,
        label: fieldLabels[field] ?? field,
        type: pVal === null ? 'added' : nVal === null ? 'deleted' : 'modified',
        before: pVal,
        after: nVal,
      });
    }
  }

  const bulletsDiff = _rawStringArrayDiff(prev.bullets, next.bullets);
  if (bulletsDiff.added.length > 0 || bulletsDiff.deleted.length > 0) {
    changes.push({
      field: 'bullets',
      label: fieldLabels.bullets ?? '업무 내용',
      type: 'array',
      added: bulletsDiff.added,
      deleted: bulletsDiff.deleted,
    });
  }

  return changes;
}

/**
 * 학력 항목 필드 diff
 * @returns {FieldChange[]}
 */
function _diffEducationItem(prev, next, fieldLabels) {
  const changes = [];
  const fields = ['institution', 'degree', 'field', 'start_date', 'end_date', 'gpa'];
  for (const f of fields) {
    const pVal = _nullableStr(prev[f]);
    const nVal = _nullableStr(next[f]);
    if (pVal !== nVal) {
      changes.push({
        field: f,
        label: fieldLabels[f] ?? f,
        type: pVal === null ? 'added' : nVal === null ? 'deleted' : 'modified',
        before: pVal,
        after: nVal,
      });
    }
  }
  return changes;
}

/**
 * 프로젝트 항목 필드 diff
 * @returns {FieldChange[]}
 */
function _diffProjectItem(prev, next, fieldLabels) {
  const changes = [];
  const scalarFields = ['name', 'description', 'url'];

  for (const f of scalarFields) {
    const pVal = _nullableStr(prev[f]);
    const nVal = _nullableStr(next[f]);
    if (pVal !== nVal) {
      changes.push({
        field: f,
        label: fieldLabels[f] ?? f,
        type: pVal === null ? 'added' : nVal === null ? 'deleted' : 'modified',
        before: pVal,
        after: nVal,
      });
    }
  }

  const bulletsDiff = _rawStringArrayDiff(prev.bullets, next.bullets);
  if (bulletsDiff.added.length > 0 || bulletsDiff.deleted.length > 0) {
    changes.push({
      field: 'bullets',
      label: fieldLabels.bullets ?? '주요 내용',
      type: 'array',
      added: bulletsDiff.added,
      deleted: bulletsDiff.deleted,
    });
  }

  const techDiff = _rawStringArrayDiff(prev.tech_stack, next.tech_stack);
  if (techDiff.added.length > 0 || techDiff.deleted.length > 0) {
    changes.push({
      field: 'tech_stack',
      label: fieldLabels.tech_stack ?? '기술 스택',
      type: 'array',
      added: techDiff.added,
      deleted: techDiff.deleted,
    });
  }

  return changes;
}

/**
 * 자격증 항목 필드 diff
 * @returns {FieldChange[]}
 */
function _diffCertItem(prev, next, fieldLabels) {
  const changes = [];
  const fields = ['name', 'issuer', 'date', 'expiry_date', 'url'];
  for (const f of fields) {
    const pVal = _nullableStr(prev[f]);
    const nVal = _nullableStr(next[f]);
    if (pVal !== nVal) {
      changes.push({
        field: f,
        label: fieldLabels[f] ?? f,
        type: pVal === null ? 'added' : nVal === null ? 'deleted' : 'modified',
        before: pVal,
        after: nVal,
      });
    }
  }
  return changes;
}

// ─── 키 추출 함수 ─────────────────────────────────────────────────────────────

function _experienceKey(item) {
  const company = _normalizeStr(item.company);
  const title = _normalizeStr(item.title);
  if (!company && !title) return '';
  return company ? `${company}::${title}` : title;
}

function _educationKey(item) {
  return _normalizeStr(item.institution);
}

function _projectKey(item) {
  return _normalizeStr(item.name);
}

function _certKey(item) {
  return _normalizeStr(item.name);
}

// ─── 공통 유틸리티 ────────────────────────────────────────────────────────────

/**
 * 문자열 배열의 set-based diff
 * @returns {{ added: string[], deleted: string[] }}
 */
function _rawStringArrayDiff(prev, next) {
  const prevSet = new Map(
    (Array.isArray(prev) ? prev : [])
      .map((s) => String(s).trim())
      .filter(Boolean)
      .map((s) => [_normalizeStr(s), s])
  );
  const nextSet = new Map(
    (Array.isArray(next) ? next : [])
      .map((s) => String(s).trim())
      .filter(Boolean)
      .map((s) => [_normalizeStr(s), s])
  );

  const added = [];
  const deleted = [];

  for (const [norm, original] of nextSet) {
    if (!prevSet.has(norm)) added.push(original);
  }
  for (const [norm, original] of prevSet) {
    if (!nextSet.has(norm)) deleted.push(original);
  }

  return { added, deleted };
}

/**
 * 항목을 식별하기 위한 짧은 레이블을 반환한다.
 * @param {object} item
 * @returns {string}
 */
function _itemLabel(item) {
  if (!item) return '';
  // 경력
  if (item.company || item.title) {
    const parts = [item.company, item.title].filter(Boolean);
    return parts.join(' — ');
  }
  // 학력
  if (item.institution) {
    return [item.institution, item.degree].filter(Boolean).join(' ');
  }
  // 프로젝트·자격증
  return item.name ?? '';
}

/**
 * 문자열을 정규화한다 (소문자, 공백 정리, 구두점 제거).
 * @param {unknown} val
 * @returns {string}
 */
function _normalizeStr(val) {
  if (val === null || val === undefined) return '';
  return String(val)
    .toLowerCase()
    .trim()
    .replace(/[.,\-–—&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * null/undefined/빈 문자열을 null로, 그 외는 trim된 문자열로 반환한다.
 * @param {unknown} val
 * @returns {string|null}
 */
function _nullableStr(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  return s || null;
}

// ─── JSDoc 타입 정의 ──────────────────────────────────────────────────────────

/**
 * @typedef {Object} FieldChange
 * @property {string} field   필드 키
 * @property {string} label   사람이 읽기 쉬운 필드 이름
 * @property {'added'|'deleted'|'modified'|'array'} type
 * @property {string|null} [before]  이전 값 (scalar 변경)
 * @property {string|null} [after]   이후 값 (scalar 변경)
 * @property {string[]} [added]      추가된 항목 (array 변경)
 * @property {string[]} [deleted]    삭제된 항목 (array 변경)
 */

/**
 * @typedef {Object} SectionDiff
 * @property {string} key     섹션 키 (예: 'experience')
 * @property {string} label   섹션 레이블 (예: '경력')
 * @property {'scalar'|'text'|'array'|'skills'|'tags'} type
 *
 * scalar (연락처):
 * @property {FieldChange[]} [fields]
 *
 * text (자기소개):
 * @property {string} [before]
 * @property {string} [after]
 *
 * array (경력·학력·프로젝트·자격증):
 * @property {object[]} [added]
 * @property {object[]} [deleted]
 * @property {{ key, label, before, after, fieldChanges, userOwned }[]} [modified]
 *
 * skills:
 * @property {{ added: string[], deleted: string[], label: string }} [technical]
 * @property {{ added: string[], deleted: string[], label: string }} [languages]
 * @property {{ added: string[], deleted: string[], label: string }} [tools]
 *
 * tags (강점 키워드):
 * @property {string[]} [added]
 * @property {string[]} [deleted]
 */
