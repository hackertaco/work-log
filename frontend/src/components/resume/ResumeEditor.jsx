import { useState, useCallback } from 'preact/hooks';

/**
 * ResumeEditor
 *
 * 이력서 전체 문서를 편집 가능한 폼 상태로 관리하는 컴포넌트.
 *
 * 편집 단위:
 *   - bullet이 최소 편집 단위 (constraints 준수)
 *   - experience / projects의 bullet 배열 각 항목을 개별 textarea로 편집
 *   - sentence 단위 조작은 bullet 텍스트 편집으로 처리 (sub-item 구조 없음)
 *
 * 저장 흐름:
 *   1. 사용자가 필드/bullet 수정
 *   2. "저장" 클릭 → PATCH /api/resume 호출 (modified fields + _sources 표시)
 *   3. 성공 시 onSaved 콜백 호출 (부모가 최신 데이터 재조회)
 *
 * 취소 흐름:
 *   - "취소" 클릭 → 로컬 state를 원본 resume prop 기준으로 reset
 *   - onCancel 콜백 호출 (부모가 editor 닫기)
 *
 * props:
 *   resume   — GET /api/resume 응답에서 꺼낸 resume 문서 객체 (read-only)
 *   onSaved  — 저장 성공 후 부모가 데이터를 재로드할 콜백
 *   onCancel — 편집 취소 시 부모가 editor를 닫을 콜백
 */
export function ResumeEditor({ resume, onSaved, onCancel }) {
  // ─── 로컬 편집 상태 초기화 ────────────────────────────────────────────────
  const [draft, setDraft] = useState(() => deepClone(resume));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  // ─── 필드 업데이트 헬퍼 ──────────────────────────────────────────────────
  /** 최상위 단순 필드 업데이트 (summary 등) */
  const setField = useCallback((key, value) => {
    setDraft((d) => ({ ...d, [key]: value }));
  }, []);

  /** contact 하위 필드 업데이트 */
  const setContact = useCallback((key, value) => {
    setDraft((d) => ({ ...d, contact: { ...d.contact, [key]: value } }));
  }, []);

  /** skills 하위 배열 필드 업데이트 (comma-separated string → string[]) */
  const setSkillsField = useCallback((key, raw) => {
    const arr = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    setDraft((d) => ({ ...d, skills: { ...d.skills, [key]: arr } }));
  }, []);

  /** experience 항목 메타 필드 업데이트 */
  const setExpField = useCallback((idx, key, value) => {
    setDraft((d) => {
      const list = [...d.experience];
      list[idx] = { ...list[idx], [key]: value };
      return { ...d, experience: list };
    });
  }, []);

  /** experience 항목 bullet 업데이트 */
  const setExpBullet = useCallback((expIdx, bulletIdx, value) => {
    setDraft((d) => {
      const list = [...d.experience];
      const bullets = [...(list[expIdx].bullets ?? [])];
      bullets[bulletIdx] = value;
      list[expIdx] = { ...list[expIdx], bullets };
      return { ...d, experience: list };
    });
  }, []);

  /** experience 항목 bullet 추가 */
  const addExpBullet = useCallback((expIdx) => {
    setDraft((d) => {
      const list = [...d.experience];
      const bullets = [...(list[expIdx].bullets ?? []), ''];
      list[expIdx] = { ...list[expIdx], bullets };
      return { ...d, experience: list };
    });
  }, []);

  /** experience 항목 bullet 삭제 */
  const removeExpBullet = useCallback((expIdx, bulletIdx) => {
    setDraft((d) => {
      const list = [...d.experience];
      const bullets = (list[expIdx].bullets ?? []).filter((_, i) => i !== bulletIdx);
      list[expIdx] = { ...list[expIdx], bullets };
      return { ...d, experience: list };
    });
  }, []);

  /** projects 항목 메타 필드 업데이트 */
  const setProjField = useCallback((idx, key, value) => {
    setDraft((d) => {
      const list = [...d.projects];
      list[idx] = { ...list[idx], [key]: value };
      return { ...d, projects: list };
    });
  }, []);

  /** projects 항목 bullet 업데이트 */
  const setProjBullet = useCallback((projIdx, bulletIdx, value) => {
    setDraft((d) => {
      const list = [...d.projects];
      const bullets = [...(list[projIdx].bullets ?? [])];
      bullets[bulletIdx] = value;
      list[projIdx] = { ...list[projIdx], bullets };
      return { ...d, projects: list };
    });
  }, []);

  /** projects 항목 bullet 추가 */
  const addProjBullet = useCallback((projIdx) => {
    setDraft((d) => {
      const list = [...d.projects];
      const bullets = [...(list[projIdx].bullets ?? []), ''];
      list[projIdx] = { ...list[projIdx], bullets };
      return { ...d, projects: list };
    });
  }, []);

  /** projects 항목 bullet 삭제 */
  const removeProjBullet = useCallback((projIdx, bulletIdx) => {
    setDraft((d) => {
      const list = [...d.projects];
      const bullets = (list[projIdx].bullets ?? []).filter((_, i) => i !== bulletIdx);
      list[projIdx] = { ...list[projIdx], bullets };
      return { ...d, projects: list };
    });
  }, []);

  /** education 항목 필드 업데이트 */
  const setEduField = useCallback((idx, key, value) => {
    setDraft((d) => {
      const list = [...d.education];
      list[idx] = { ...list[idx], [key]: value };
      return { ...d, education: list };
    });
  }, []);

  /** certifications 항목 필드 업데이트 */
  const setCertField = useCallback((idx, key, value) => {
    setDraft((d) => {
      const list = [...d.certifications];
      list[idx] = { ...list[idx], [key]: value };
      return { ...d, certifications: list };
    });
  }, []);

  // ─── 취소 ─────────────────────────────────────────────────────────────────
  function handleCancel() {
    setDraft(deepClone(resume));
    setSaveError('');
    onCancel?.();
  }

  // ─── 저장 ─────────────────────────────────────────────────────────────────
  async function handleSave() {
    setSaving(true);
    setSaveError('');
    try {
      const res = await fetch('/api/resume', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resume: draft }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `서버 오류: HTTP ${res.status}`);
      }
      onSaved?.();
    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSaving(false);
    }
  }

  // ─── 렌더링 ───────────────────────────────────────────────────────────────
  const {
    contact = {},
    summary = '',
    experience = [],
    projects = [],
    education = [],
    skills = {},
    certifications = [],
  } = draft;

  return (
    <div class="re-root" aria-label="이력서 편집">
      {/* ─── 편집 헤더 + 저장/취소 (상단) ─── */}
      <EditorToolbar
        saving={saving}
        onSave={handleSave}
        onCancel={handleCancel}
      />

      {saveError && (
        <div class="re-error" role="alert">{saveError}</div>
      )}

      {/* ─── 연락처 섹션 ─── */}
      <EditorSection title="연락처" kicker="CONTACT">
        <ContactEditor contact={contact} onChange={setContact} />
      </EditorSection>

      {/* ─── 개요 섹션 ─── */}
      <EditorSection title="개요" kicker="SUMMARY">
        <SummaryEditor value={summary} onChange={(v) => setField('summary', v)} />
      </EditorSection>

      {/* ─── 경력 섹션 ─── */}
      <EditorSection title="경력" kicker="EXPERIENCE">
        {experience.length === 0
          ? <p class="re-empty">경력 항목이 없습니다.</p>
          : experience.map((exp, i) => (
            <ExperienceEditor
              key={i}
              index={i}
              exp={exp}
              onFieldChange={setExpField}
              onBulletChange={setExpBullet}
              onAddBullet={addExpBullet}
              onRemoveBullet={removeExpBullet}
            />
          ))
        }
      </EditorSection>

      {/* ─── 프로젝트 섹션 ─── */}
      <EditorSection title="프로젝트" kicker="PROJECTS">
        {projects.length === 0
          ? <p class="re-empty">프로젝트 항목이 없습니다.</p>
          : projects.map((proj, i) => (
            <ProjectEditor
              key={i}
              index={i}
              proj={proj}
              onFieldChange={setProjField}
              onBulletChange={setProjBullet}
              onAddBullet={addProjBullet}
              onRemoveBullet={removeProjBullet}
            />
          ))
        }
      </EditorSection>

      {/* ─── 학력 섹션 ─── */}
      <EditorSection title="학력" kicker="EDUCATION">
        {education.length === 0
          ? <p class="re-empty">학력 항목이 없습니다.</p>
          : education.map((edu, i) => (
            <EducationEditor
              key={i}
              index={i}
              edu={edu}
              onFieldChange={setEduField}
            />
          ))
        }
      </EditorSection>

      {/* ─── 기술 섹션 ─── */}
      <EditorSection title="기술" kicker="SKILLS">
        <SkillsEditor skills={skills} onChange={setSkillsField} />
      </EditorSection>

      {/* ─── 자격증 섹션 ─── */}
      <EditorSection title="자격증·수료" kicker="CERTIFICATIONS">
        {certifications.length === 0
          ? <p class="re-empty">자격증 항목이 없습니다.</p>
          : certifications.map((cert, i) => (
            <CertificationEditor
              key={i}
              index={i}
              cert={cert}
              onFieldChange={setCertField}
            />
          ))
        }
      </EditorSection>

      {/* ─── 저장/취소 (하단 반복) ─── */}
      <EditorToolbar
        saving={saving}
        onSave={handleSave}
        onCancel={handleCancel}
        bottom
      />

      <style>{EDITOR_CSS}</style>
    </div>
  );
}

/* ──────────────────────────────────────────── */
/* Sub-components: 섹션 편집기                  */
/* ──────────────────────────────────────────── */

/** 편집기 섹션 공통 래퍼 */
function EditorSection({ title, kicker, children }) {
  return (
    <section class="re-section">
      <div class="re-section-heading">
        {kicker && <p class="re-kicker">{kicker}</p>}
        <h2 class="re-section-title">{title}</h2>
      </div>
      <div class="re-section-body">{children}</div>
    </section>
  );
}

/** 저장/취소 툴바 */
function EditorToolbar({ saving, onSave, onCancel, bottom = false }) {
  return (
    <div class={`re-toolbar${bottom ? ' re-toolbar--bottom' : ''}`}>
      <p class="re-toolbar-hint">
        {bottom ? '' : '수정 후 저장하면 이력서에 즉시 반영됩니다.'}
      </p>
      <div class="re-toolbar-actions">
        <button
          class="re-btn re-btn--cancel"
          type="button"
          onClick={onCancel}
          disabled={saving}
        >
          취소
        </button>
        <button
          class="re-btn re-btn--save"
          type="button"
          onClick={onSave}
          disabled={saving}
        >
          {saving ? '저장 중…' : '저장'}
        </button>
      </div>
    </div>
  );
}

/** 연락처 편집기 */
function ContactEditor({ contact, onChange }) {
  const fields = [
    { key: 'name',     label: '이름',         type: 'text' },
    { key: 'email',    label: '이메일',        type: 'email' },
    { key: 'phone',    label: '전화번호',      type: 'tel' },
    { key: 'location', label: '위치',          type: 'text' },
    { key: 'website',  label: '웹사이트',      type: 'url' },
    { key: 'linkedin', label: 'LinkedIn URL',  type: 'url' },
  ];

  return (
    <div class="re-field-grid">
      {fields.map(({ key, label, type }) => (
        <div key={key} class="re-field">
          <label class="re-label" for={`contact-${key}`}>{label}</label>
          <input
            id={`contact-${key}`}
            class="re-input"
            type={type}
            value={contact[key] ?? ''}
            onInput={(e) => onChange(key, e.target.value || null)}
            placeholder={label}
            autocomplete="off"
          />
        </div>
      ))}
    </div>
  );
}

/** 개요(summary) 편집기 */
function SummaryEditor({ value, onChange }) {
  return (
    <div class="re-field">
      <label class="re-label" for="summary-text">개요 텍스트</label>
      <textarea
        id="summary-text"
        class="re-textarea re-textarea--summary"
        value={value}
        onInput={(e) => onChange(e.target.value)}
        placeholder="직업적 개요 또는 자기소개를 입력하세요."
        rows={4}
      />
    </div>
  );
}

/**
 * 경력 항목 편집기
 * bullet은 최소 편집 단위 — 각 bullet을 개별 textarea로 표시
 */
function ExperienceEditor({ index, exp, onFieldChange, onBulletChange, onAddBullet, onRemoveBullet }) {
  const {
    company = '',
    title = '',
    start_date = '',
    end_date = '',
    location: loc = '',
    bullets = [],
  } = exp;

  const prefix = `exp-${index}`;

  return (
    <div class="re-item">
      <div class="re-item-meta re-field-grid">
        <div class="re-field">
          <label class="re-label" for={`${prefix}-title`}>직함</label>
          <input
            id={`${prefix}-title`}
            class="re-input"
            type="text"
            value={title}
            onInput={(e) => onFieldChange(index, 'title', e.target.value)}
            placeholder="직함"
          />
        </div>
        <div class="re-field">
          <label class="re-label" for={`${prefix}-company`}>회사</label>
          <input
            id={`${prefix}-company`}
            class="re-input"
            type="text"
            value={company}
            onInput={(e) => onFieldChange(index, 'company', e.target.value)}
            placeholder="회사명"
          />
        </div>
        <div class="re-field">
          <label class="re-label" for={`${prefix}-location`}>위치</label>
          <input
            id={`${prefix}-location`}
            class="re-input"
            type="text"
            value={loc}
            onInput={(e) => onFieldChange(index, 'location', e.target.value)}
            placeholder="위치 (선택)"
          />
        </div>
        <div class="re-field">
          <label class="re-label" for={`${prefix}-start`}>시작일</label>
          <input
            id={`${prefix}-start`}
            class="re-input"
            type="text"
            value={start_date ?? ''}
            onInput={(e) => onFieldChange(index, 'start_date', e.target.value || null)}
            placeholder="YYYY-MM"
          />
        </div>
        <div class="re-field">
          <label class="re-label" for={`${prefix}-end`}>종료일</label>
          <input
            id={`${prefix}-end`}
            class="re-input"
            type="text"
            value={end_date ?? ''}
            onInput={(e) => onFieldChange(index, 'end_date', e.target.value || null)}
            placeholder="YYYY-MM 또는 현재"
          />
        </div>
      </div>

      <div class="re-bullets-section">
        <p class="re-bullets-label">주요 업무 (Bullets)</p>
        <div class="re-bullets-list">
          {bullets.map((bullet, bi) => (
            <BulletEditor
              key={bi}
              value={bullet}
              onChange={(v) => onBulletChange(index, bi, v)}
              onRemove={() => onRemoveBullet(index, bi)}
            />
          ))}
        </div>
        <button
          class="re-btn-add-bullet"
          type="button"
          onClick={() => onAddBullet(index)}
        >
          + Bullet 추가
        </button>
      </div>
    </div>
  );
}

/**
 * 프로젝트 항목 편집기
 * bullet은 최소 편집 단위 — 각 bullet을 개별 textarea로 표시
 */
function ProjectEditor({ index, proj, onFieldChange, onBulletChange, onAddBullet, onRemoveBullet }) {
  const {
    title = '',
    name = '',
    description = '',
    url = '',
    tech_stack = [],
    bullets = [],
  } = proj;

  const displayName = title || name;
  const prefix = `proj-${index}`;

  return (
    <div class="re-item">
      <div class="re-item-meta re-field-grid">
        <div class="re-field">
          <label class="re-label" for={`${prefix}-title`}>프로젝트명</label>
          <input
            id={`${prefix}-title`}
            class="re-input"
            type="text"
            value={displayName}
            onInput={(e) => {
              onFieldChange(index, 'title', e.target.value);
              onFieldChange(index, 'name', e.target.value);
            }}
            placeholder="프로젝트 이름"
          />
        </div>
        <div class="re-field">
          <label class="re-label" for={`${prefix}-url`}>URL</label>
          <input
            id={`${prefix}-url`}
            class="re-input"
            type="url"
            value={url}
            onInput={(e) => onFieldChange(index, 'url', e.target.value)}
            placeholder="https://..."
          />
        </div>
        <div class="re-field re-field--full">
          <label class="re-label" for={`${prefix}-desc`}>설명</label>
          <textarea
            id={`${prefix}-desc`}
            class="re-textarea"
            value={description}
            onInput={(e) => onFieldChange(index, 'description', e.target.value)}
            placeholder="프로젝트 설명"
            rows={2}
          />
        </div>
        <div class="re-field re-field--full">
          <label class="re-label" for={`${prefix}-stack`}>기술 스택 (쉼표 구분)</label>
          <input
            id={`${prefix}-stack`}
            class="re-input"
            type="text"
            value={tech_stack.join(', ')}
            onInput={(e) => {
              const arr = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
              onFieldChange(index, 'tech_stack', arr);
            }}
            placeholder="React, Node.js, PostgreSQL"
          />
        </div>
      </div>

      <div class="re-bullets-section">
        <p class="re-bullets-label">주요 내용 (Bullets)</p>
        <div class="re-bullets-list">
          {bullets.map((bullet, bi) => (
            <BulletEditor
              key={bi}
              value={bullet}
              onChange={(v) => onBulletChange(index, bi, v)}
              onRemove={() => onRemoveBullet(index, bi)}
            />
          ))}
        </div>
        <button
          class="re-btn-add-bullet"
          type="button"
          onClick={() => onAddBullet(index)}
        >
          + Bullet 추가
        </button>
      </div>
    </div>
  );
}

/** 학력 항목 편집기 */
function EducationEditor({ index, edu, onFieldChange }) {
  const {
    institution = '',
    degree = '',
    field = '',
    start_date = '',
    end_date = '',
    gpa = '',
  } = edu;

  const prefix = `edu-${index}`;

  return (
    <div class="re-item">
      <div class="re-item-meta re-field-grid">
        <div class="re-field">
          <label class="re-label" for={`${prefix}-institution`}>학교명</label>
          <input
            id={`${prefix}-institution`}
            class="re-input"
            type="text"
            value={institution}
            onInput={(e) => onFieldChange(index, 'institution', e.target.value)}
            placeholder="학교명"
          />
        </div>
        <div class="re-field">
          <label class="re-label" for={`${prefix}-degree`}>학위</label>
          <input
            id={`${prefix}-degree`}
            class="re-input"
            type="text"
            value={degree}
            onInput={(e) => onFieldChange(index, 'degree', e.target.value)}
            placeholder="학사, 석사 등"
          />
        </div>
        <div class="re-field">
          <label class="re-label" for={`${prefix}-field`}>전공</label>
          <input
            id={`${prefix}-field`}
            class="re-input"
            type="text"
            value={field}
            onInput={(e) => onFieldChange(index, 'field', e.target.value)}
            placeholder="전공 분야"
          />
        </div>
        <div class="re-field">
          <label class="re-label" for={`${prefix}-start`}>입학일</label>
          <input
            id={`${prefix}-start`}
            class="re-input"
            type="text"
            value={start_date ?? ''}
            onInput={(e) => onFieldChange(index, 'start_date', e.target.value || null)}
            placeholder="YYYY-MM"
          />
        </div>
        <div class="re-field">
          <label class="re-label" for={`${prefix}-end`}>졸업일</label>
          <input
            id={`${prefix}-end`}
            class="re-input"
            type="text"
            value={end_date ?? ''}
            onInput={(e) => onFieldChange(index, 'end_date', e.target.value || null)}
            placeholder="YYYY-MM"
          />
        </div>
        <div class="re-field">
          <label class="re-label" for={`${prefix}-gpa`}>GPA</label>
          <input
            id={`${prefix}-gpa`}
            class="re-input"
            type="text"
            value={gpa ?? ''}
            onInput={(e) => onFieldChange(index, 'gpa', e.target.value || null)}
            placeholder="선택"
          />
        </div>
      </div>
    </div>
  );
}

/**
 * 기술(skills) 편집기
 * technical / languages / tools 각각 쉼표 구분 입력
 */
function SkillsEditor({ skills, onChange }) {
  const groups = [
    { key: 'technical', label: 'Technical 스킬', placeholder: 'Python, Go, TypeScript, …' },
    { key: 'languages', label: '사용 언어',       placeholder: 'English, Korean, …' },
    { key: 'tools',     label: '도구 / 플랫폼',   placeholder: 'Docker, Kubernetes, AWS, …' },
  ];

  return (
    <div class="re-field-col">
      {groups.map(({ key, label, placeholder }) => (
        <div key={key} class="re-field">
          <label class="re-label" for={`skills-${key}`}>{label}</label>
          <input
            id={`skills-${key}`}
            class="re-input"
            type="text"
            value={(skills[key] ?? []).join(', ')}
            onInput={(e) => onChange(key, e.target.value)}
            placeholder={placeholder}
          />
          <p class="re-hint">쉼표(,)로 구분</p>
        </div>
      ))}
    </div>
  );
}

/** 자격증 항목 편집기 */
function CertificationEditor({ index, cert, onFieldChange }) {
  const {
    title = '',
    name = '',
    issuer = '',
    date = '',
    issued_date = '',
    expiry_date = '',
    url = '',
  } = cert;

  const displayName = title || name;
  const displayDate = date || issued_date;
  const prefix = `cert-${index}`;

  return (
    <div class="re-item">
      <div class="re-item-meta re-field-grid">
        <div class="re-field">
          <label class="re-label" for={`${prefix}-name`}>자격증명</label>
          <input
            id={`${prefix}-name`}
            class="re-input"
            type="text"
            value={displayName}
            onInput={(e) => {
              onFieldChange(index, 'name', e.target.value);
              onFieldChange(index, 'title', e.target.value);
            }}
            placeholder="자격증 또는 수료증 이름"
          />
        </div>
        <div class="re-field">
          <label class="re-label" for={`${prefix}-issuer`}>발급 기관</label>
          <input
            id={`${prefix}-issuer`}
            class="re-input"
            type="text"
            value={issuer}
            onInput={(e) => onFieldChange(index, 'issuer', e.target.value)}
            placeholder="발급 기관"
          />
        </div>
        <div class="re-field">
          <label class="re-label" for={`${prefix}-date`}>취득일</label>
          <input
            id={`${prefix}-date`}
            class="re-input"
            type="text"
            value={displayDate}
            onInput={(e) => {
              onFieldChange(index, 'date', e.target.value);
              onFieldChange(index, 'issued_date', e.target.value);
            }}
            placeholder="YYYY-MM"
          />
        </div>
        <div class="re-field">
          <label class="re-label" for={`${prefix}-expiry`}>만료일</label>
          <input
            id={`${prefix}-expiry`}
            class="re-input"
            type="text"
            value={expiry_date ?? ''}
            onInput={(e) => onFieldChange(index, 'expiry_date', e.target.value || null)}
            placeholder="YYYY-MM (없으면 비워두기)"
          />
        </div>
        <div class="re-field">
          <label class="re-label" for={`${prefix}-url`}>링크</label>
          <input
            id={`${prefix}-url`}
            class="re-input"
            type="url"
            value={url}
            onInput={(e) => onFieldChange(index, 'url', e.target.value)}
            placeholder="https://..."
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Bullet 단위 편집기 (최소 편집 단위)
 * sentence 단위 조작은 이 textarea 텍스트 편집으로 처리 (sub-item 없음)
 */
function BulletEditor({ value, onChange, onRemove }) {
  return (
    <div class="re-bullet-row">
      <span class="re-bullet-marker" aria-hidden="true">•</span>
      <textarea
        class="re-textarea re-textarea--bullet"
        value={value}
        onInput={(e) => onChange(e.target.value)}
        rows={2}
        placeholder="업무 내용을 입력하세요"
      />
      <button
        class="re-btn-remove-bullet"
        type="button"
        onClick={onRemove}
        aria-label="bullet 삭제"
        title="삭제"
      >
        ×
      </button>
    </div>
  );
}

/* ──────────────────────────────────────────── */
/* Utilities                                    */
/* ──────────────────────────────────────────── */

/** resume 객체의 깊은 복사 (JSON 직렬화 기반) */
function deepClone(obj) {
  if (obj == null) return obj;
  return JSON.parse(JSON.stringify(obj));
}

/* ──────────────────────────────────────────── */
/* Styles                                       */
/* ──────────────────────────────────────────── */

const EDITOR_CSS = `
  /* ─── 루트 ─── */
  .re-root {
    max-width: 720px;
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }

  /* ─── 오류 배너 ─── */
  .re-error {
    padding: var(--space-3) var(--space-4);
    background: #fef2f2;
    border: 1px solid #fca5a5;
    border-radius: var(--radius-md);
    font-size: 13px;
    color: #dc2626;
  }

  /* ─── 툴바 ─── */
  .re-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-4);
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
  }

  .re-toolbar--bottom {
    margin-top: var(--space-2);
  }

  .re-toolbar-hint {
    margin: 0;
    font-size: 12px;
    color: var(--muted);
  }

  .re-toolbar-actions {
    display: flex;
    gap: var(--space-3);
    flex-shrink: 0;
  }

  /* ─── 섹션 ─── */
  .re-section {
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .re-section-heading {
    padding: var(--space-3) var(--space-4);
    background: var(--surface);
    border-bottom: 1px solid var(--line);
  }

  .re-kicker {
    margin: 0 0 2px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .re-section-title {
    margin: 0;
    font-size: 14px;
    font-weight: 700;
    color: var(--ink);
  }

  .re-section-body {
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  /* ─── 항목 카드 ─── */
  .re-item {
    padding: var(--space-4);
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-md);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  /* ─── 필드 그리드 ─── */
  .re-field-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3);
  }

  .re-field-col {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .re-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .re-field--full {
    grid-column: 1 / -1;
  }

  .re-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .re-hint {
    margin: 0;
    font-size: 11px;
    color: var(--muted);
  }

  .re-input,
  .re-textarea {
    width: 100%;
    padding: 7px 10px;
    font-size: 13px;
    font-family: inherit;
    color: var(--ink);
    background: var(--bg);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    transition: border-color 0.15s, box-shadow 0.15s;
    box-sizing: border-box;
  }

  .re-input:focus,
  .re-textarea:focus {
    outline: none;
    border-color: var(--ink);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 12%, transparent);
  }

  .re-textarea {
    resize: vertical;
    line-height: 1.5;
  }

  .re-textarea--summary {
    min-height: 80px;
  }

  .re-textarea--bullet {
    min-height: 44px;
    flex: 1;
  }

  /* ─── Bullet 편집 영역 ─── */
  .re-bullets-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .re-bullets-label {
    margin: 0;
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .re-bullets-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .re-bullet-row {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
  }

  .re-bullet-marker {
    padding-top: 9px;
    flex-shrink: 0;
    font-size: 14px;
    color: var(--muted);
    user-select: none;
  }

  /* ─── 빈 상태 ─── */
  .re-empty {
    margin: 0;
    font-size: 13px;
    color: var(--muted);
    font-style: italic;
  }

  /* ─── 버튼 ─── */
  .re-btn {
    padding: 7px 16px;
    font-size: 13px;
    font-weight: 600;
    border-radius: var(--radius-md);
    border: none;
    transition: opacity 0.15s, background 0.15s;
    white-space: nowrap;
  }

  .re-btn:disabled {
    opacity: 0.5;
    pointer-events: none;
  }

  .re-btn--save {
    background: var(--ink);
    color: #fff;
  }

  .re-btn--save:hover {
    opacity: 0.82;
  }

  .re-btn--cancel {
    background: transparent;
    color: var(--muted);
    border: 1px solid var(--line-strong);
  }

  .re-btn--cancel:hover {
    color: var(--ink);
    border-color: var(--ink);
  }

  .re-btn-add-bullet {
    align-self: flex-start;
    padding: 5px 12px;
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
    background: transparent;
    border: 1px dashed var(--line-strong);
    border-radius: var(--radius-sm);
    transition: color 0.15s, border-color 0.15s;
  }

  .re-btn-add-bullet:hover {
    color: var(--ink);
    border-color: var(--ink);
    border-style: solid;
  }

  .re-btn-remove-bullet {
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    margin-top: 8px;
    font-size: 16px;
    line-height: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    color: var(--muted);
    border: none;
    border-radius: var(--radius-sm);
    transition: color 0.15s, background 0.15s;
  }

  .re-btn-remove-bullet:hover {
    color: #dc2626;
    background: #fef2f2;
  }

  /* ─── 반응형 ─── */
  @media (max-width: 600px) {
    .re-field-grid {
      grid-template-columns: 1fr;
    }
    .re-field--full {
      grid-column: 1;
    }
  }

  /* ─── 인쇄 제외 ─── */
  @media print {
    .re-root {
      display: none !important;
    }
  }
`;
