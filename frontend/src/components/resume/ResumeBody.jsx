import { useState, useEffect, useRef } from 'preact/hooks';
import { BulletProposalChip, BULLET_PROPOSAL_CSS } from './BulletProposalChip.jsx';

/**
 * ResumeBody
 *
 * 이력서 본문 카드 컴포넌트. GET /api/resume 응답의 resume 객체를 받아
 * 섹션별로 렌더링한다.
 *
 * 고정 최소 섹션 스키마:
 *   contact          — { name, email, phone, location, website, linkedin }
 *   summary          — string
 *   experience       — [{ company, title, start_date, end_date, location, bullets, _source }]
 *   education        — [{ institution, degree, field, start_date, end_date, gpa, _source }]
 *   skills           — { technical: string[], languages: string[], tools: string[] }
 *   projects         — [{ name|title, description, url, bullets, tech_stack, _source }]
 *   certifications   — [{ name|title, issuer, date|issued_date, expiry_date, url, _source }]
 *   strength_keywords — string[]  (비정형 누적 목록, 화면 전용 — 인쇄 제외)
 *   meta             — { language, source, generatedAt, schemaVersion, pdf_name, linkedin_url }
 *   _sources         — { summary?: 'user'|'system', ... } (섹션별 provenance 태그)
 *
 * props:
 *   resume              — 위 스키마의 이력서 객체. null이면 empty state 표시.
 *   loading             — true이면 스켈레톤 로딩 UI 표시.
 *   onBulletAdded       — (선택, 레거시) bullet 직접 추가 후 호출되는 fallback 콜백.
 *                         onBulletAdd가 없을 때만 사용된다.
 *   onBulletAdd         — (선택) bullet 추가 액션 핸들러
 *                         (section, itemIndex, bullet) => Promise<void>
 *                         API 응답으로 로컬 resume 상태를 즉시 갱신한다.
 *   onBulletEdit        — (선택) bullet 편집 액션 핸들러
 *                         (section, itemIndex, bulletIndex, text) => Promise<void>
 *                         API 응답으로 로컬 resume 상태를 즉시 갱신한다.
 *   onBulletDelete      — (선택) bullet 삭제 액션 핸들러
 *                         (section, itemIndex, bulletIndex) => Promise<void>
 *                         API 응답으로 로컬 resume 상태를 즉시 갱신한다.
 *   bulletProposals     — (선택) 불릿 단위 제안 목록 (SuggestionItem[]).
 *                         action: 'append_bullet' | 'replace_bullet' | 'delete_bullet'
 *                         해당 경험/프로젝트 항목 내에 인라인으로 표시된다.
 *   onProposalApproved  — (선택) 제안 승인 완료 콜백 (id: string) => void
 *   onProposalRejected  — (선택) 제안 제외 완료 콜백 (id: string) => void
 *   onResumeUpdated     — (선택) 제안 승인으로 이력서 변경 시 재조회 요청 콜백
 */
export function ResumeBody({
  resume,
  loading = false,
  onBulletAdded,
  onBulletAdd,
  onBulletEdit,
  onBulletDelete,
  bulletProposals = [],
  onProposalApproved,
  onProposalRejected,
  onResumeUpdated,
}) {
  // ─── Loading skeleton ─────────────────────────────────────────────────────
  if (loading) {
    return (
      <article class="rb-body rb-state" aria-label="이력서 불러오는 중" aria-busy="true">
        <div class="rb-skeleton rb-skeleton--name" />
        <div class="rb-skeleton rb-skeleton--contact" />
        <div class="rb-divider" />
        <div class="rb-skeleton rb-skeleton--kicker" />
        <div class="rb-skeleton rb-skeleton--line" />
        <div class="rb-skeleton rb-skeleton--line rb-skeleton--short" />
        <div class="rb-skeleton rb-skeleton--kicker" style="margin-top: 12px" />
        <div class="rb-skeleton-group">
          <div class="rb-skeleton rb-skeleton--title" />
          <div class="rb-skeleton rb-skeleton--line" />
          <div class="rb-skeleton rb-skeleton--line rb-skeleton--short" />
        </div>
        <style>{RB_CSS}</style>
      </article>
    );
  }

  // ─── Empty state ──────────────────────────────────────────────────────────
  if (!resume) {
    return (
      <article class="rb-body rb-state" aria-label="이력서 없음">
        <p class="rb-empty-msg">이력서 데이터를 불러올 수 없습니다.</p>
        <style>{RB_CSS}</style>
      </article>
    );
  }

  // ─── Normal render ────────────────────────────────────────────────────────
  const {
    meta = {},
    contact = {},
    _sources = {},
    summary = '',
    experience = [],
    education = [],
    skills = {},
    projects = [],
    certifications = [],
    strength_keywords = [],
  } = resume;

  const hasSkills =
    (skills.technical?.length > 0) ||
    (skills.languages?.length > 0) ||
    (skills.tools?.length > 0);

  return (
    <article class="rb-body" aria-label="이력서 본문">
      {/* ─── 이름 + 연락처 헤더 ─── */}
      <ContactHeader contact={contact} />

      <div class="rb-divider" />

      {/* ─── 개요 (summary) ─── */}
      {summary && (
        <ResumeSection title="개요" kicker="SUMMARY" sourceTag={_sources.summary} sectionType="summary">
          <p class="rb-summary">{summary}</p>
        </ResumeSection>
      )}

      {/* ─── 경력 (experience) ─── */}
      {experience.length > 0 && (
        <ResumeSection title="경력" kicker="EXPERIENCE" sectionType="experience">
          <div class="rb-list">
            {experience.map((exp, i) => (
              <ExperienceItem
                key={i}
                exp={exp}
                itemIndex={i}
                onBulletAdded={onBulletAdded}
                onBulletAdd={onBulletAdd}
                onBulletEdit={onBulletEdit}
                onBulletDelete={onBulletDelete}
                bulletProposals={bulletProposals.filter(
                  (p) => {
                    // New BulletProposal format: match by target.section + target.itemIndex
                    if (p.kind === 'bullet') {
                      return p.target?.section === 'experience' && p.target?.itemIndex === i;
                    }
                    // Legacy SuggestionItem format
                    if (p.section !== 'experience') return false;
                    if (p.action === 'append_bullet') {
                      // matched by company name
                      return p.patch?.company === exp.company;
                    }
                    // replace_bullet / delete_bullet: matched by itemIndex
                    return p.patch?.itemIndex === i;
                  }
                )}
                onProposalApproved={onProposalApproved}
                onProposalRejected={onProposalRejected}
                onResumeUpdated={onResumeUpdated}
              />
            ))}
          </div>
        </ResumeSection>
      )}

      {/* ─── 프로젝트 (projects) ─── */}
      {projects.length > 0 && (
        <ResumeSection title="프로젝트" kicker="PROJECTS" sectionType="projects">
          <div class="rb-list">
            {projects.map((proj, i) => (
              <ProjectItem
                key={i}
                proj={proj}
                itemIndex={i}
                onBulletAdded={onBulletAdded}
                onBulletAdd={onBulletAdd}
                onBulletEdit={onBulletEdit}
                onBulletDelete={onBulletDelete}
                bulletProposals={bulletProposals.filter(
                  (p) => {
                    // New BulletProposal format: match by target.section + target.itemIndex
                    if (p.kind === 'bullet') {
                      return p.target?.section === 'projects' && p.target?.itemIndex === i;
                    }
                    // Legacy SuggestionItem format
                    if (p.section !== 'projects') return false;
                    if (p.action === 'append_bullet') {
                      // matched by project name or itemIndex
                      return (
                        p.patch?.project === (proj.name || proj.title) ||
                        p.patch?.itemIndex === i
                      );
                    }
                    // replace_bullet / delete_bullet: matched by itemIndex
                    return p.patch?.itemIndex === i;
                  }
                )}
                onProposalApproved={onProposalApproved}
                onProposalRejected={onProposalRejected}
                onResumeUpdated={onResumeUpdated}
              />
            ))}
          </div>
        </ResumeSection>
      )}

      {/* ─── 학력 (education) ─── */}
      {education.length > 0 && (
        <ResumeSection title="학력" kicker="EDUCATION" sectionType="education">
          <div class="rb-list">
            {education.map((edu, i) => (
              <EducationItem key={i} edu={edu} />
            ))}
          </div>
        </ResumeSection>
      )}

      {/* ─── 기술 (skills) ─── */}
      {hasSkills && (
        <ResumeSection title="기술" kicker="SKILLS" sectionType="skills">
          <SkillsSection skills={skills} />
        </ResumeSection>
      )}

      {/* ─── 자격증·수료 (certifications) ─── */}
      {certifications.length > 0 && (
        <ResumeSection title="자격증·수료" kicker="CERTIFICATIONS" sectionType="certifications">
          <div class="rb-list">
            {certifications.map((cert, i) => (
              <CertificationItem key={i} cert={cert} />
            ))}
          </div>
        </ResumeSection>
      )}

      {/* ─── 강점 키워드 (strength_keywords) — 비정형 누적 목록, 인쇄 제외 ─── */}
      <StrengthKeywordsSection initialKeywords={strength_keywords} />

      {/* ─── 소스 메타 ─── */}
      {(meta.source || meta.generatedAt) && (
        <p class="rb-source-note">
          {meta.source && <>출처: {meta.source}</>}
          {meta.generatedAt && (
            <>{meta.source ? ' · ' : ''}생성일: {formatDate(meta.generatedAt)}</>
          )}
        </p>
      )}

      <style>{RB_CSS + BULLET_PROPOSAL_CSS}</style>
    </article>
  );
}

/* ──────────────────────────────────────────── */
/* Sub-components                               */
/* ──────────────────────────────────────────── */

/** 이름 + 연락처 헤더 */
function ContactHeader({ contact }) {
  const { name, email, phone, location, website, linkedin } = contact;
  return (
    <div class="rb-header">
      {name
        ? <h1 class="rb-name">{name}</h1>
        : <h1 class="rb-name rb-name--placeholder">이름 없음</h1>
      }
      <div class="rb-contact">
        {email && <span>{email}</span>}
        {phone && <span>{phone}</span>}
        {location && <span>{location}</span>}
        {linkedin && (
          <a href={linkedin} target="_blank" rel="noopener noreferrer">LinkedIn</a>
        )}
        {website && (
          <a href={website} target="_blank" rel="noopener noreferrer">{website}</a>
        )}
      </div>
    </div>
  );
}

/**
 * 섹션 공통 래퍼 (kicker + 제목 + 선택적 sourceTag 배지 + 본문)
 *
 * sectionType — 인쇄 시 page-break 제어를 위한 CSS 수식자 클래스용 값.
 *   'summary' | 'experience' | 'projects' | 'education' | 'skills' | 'certifications'
 *   section-specific 클래스를 rb-section--{type} 형식으로 추가한다.
 */
function ResumeSection({ title, kicker, children, sourceTag, sectionType }) {
  const cls = sectionType ? `rb-section rb-section--${sectionType}` : 'rb-section';
  return (
    <section class={cls}>
      <div class="rb-section-heading">
        {kicker && <p class="rb-kicker">{kicker}</p>}
        <div class="rb-title-row">
          <h2 class="rb-section-title">{title}</h2>
          {sourceTag && <SourceBadge source={sourceTag} />}
        </div>
      </div>
      {children}
    </section>
  );
}

/**
 * 출처(provenance) 배지 — 세 종류:
 *   user     — 사용자가 직접 작성/편집    → 파란 배지 "편집"
 *   approved — 사용자가 시스템 제안을 승인 → 초록 배지 "승인됨"
 *   system   — 시스템이 자동 생성, 아직 사용자가 확인하지 않은 미반영 항목
 *              → 주황 배지 "미반영"
 *
 * 인쇄 시 숨김 처리 (CSS @media print).
 */
function SourceBadge({ source }) {
  if (!source) return null;

  let modifier, icon, label, title;

  if (source === 'user') {
    modifier = 'user';
    icon = '✎';
    label = '편집';
    title = '사용자가 직접 작성하거나 편집한 항목입니다.';
  } else if (source === 'approved') {
    modifier = 'approved';
    icon = '✓';
    label = '승인됨';
    title = '사용자가 시스템 제안을 승인하여 반영된 항목입니다.';
  } else {
    // 'system' 또는 기타 — 자동 생성, 미반영 상태
    modifier = 'system';
    icon = '●';
    label = '미반영';
    title = '시스템이 자동 생성한 항목입니다. 직접 편집하면 사용자 항목으로 전환됩니다.';
  }

  return (
    <span
      class={`rb-source-badge rb-source-badge--${modifier}`}
      title={title}
      aria-label={`출처: ${label}`}
    >
      <span class="rb-source-badge-icon" aria-hidden="true">{icon}</span>
      {label}
    </span>
  );
}

/**
 * 경력 항목
 * schema: { company, title, start_date, end_date, location, bullets, _source }
 *
 * props:
 *   exp                — 경력 항목 객체
 *   itemIndex          — experience 배열에서의 0-based 인덱스 (API 호출에 사용)
 *   onBulletAdded      — (선택, 레거시) bullet 추가 성공 후 fallback 콜백
 *   onBulletAdd        — (선택) bullet 추가 액션 핸들러 (section, itemIndex, bullet)
 *   onBulletEdit       — (선택) bullet 편집 액션 핸들러 (section, itemIndex, bulletIndex, text)
 *   onBulletDelete     — (선택) bullet 삭제 액션 핸들러 (section, itemIndex, bulletIndex)
 *   bulletProposals    — (선택) 이 항목에 해당하는 불릿 단위 제안 목록
 *   onProposalApproved — (선택) 제안 승인 완료 콜백 (id: string) => void
 *   onProposalRejected — (선택) 제안 제외 완료 콜백 (id: string) => void
 *   onResumeUpdated    — (선택) 이력서 변경 시 재조회 요청 콜백
 */
function ExperienceItem({
  exp,
  itemIndex,
  onBulletAdded,
  onBulletAdd,
  onBulletEdit,
  onBulletDelete,
  bulletProposals = [],
  onProposalApproved,
  onProposalRejected,
  onResumeUpdated,
}) {
  const {
    company = '',
    title = '',
    start_date = null,
    end_date = null,
    location: loc = null,
    bullets = [],
    _source,
  } = exp;

  // Local bullet state — optimistically updated after API success
  const [localBullets, setLocalBullets] = useState([...bullets]);
  // Locally removed proposal IDs (after approve/reject)
  const [removedProposalIds, setRemovedProposalIds] = useState(() => new Set());

  // Sync when the parent resume object is refreshed
  useEffect(() => {
    setLocalBullets(Array.isArray(bullets) ? [...bullets] : []);
  }, [bullets]);

  const period = formatPeriod(start_date, end_date);

  // Helper: is this proposal an "add/append" type?
  function isAddProposal(p) {
    return p.kind === 'bullet' ? p.op === 'add' : p.action === 'append_bullet';
  }

  // Helper: get the bullet index for replace/delete proposals
  function getBulletIndex(p) {
    if (p.kind === 'bullet') return p.target?.bulletIndex;
    return p.patch?.bulletIndex;
  }

  // Proposals to render after the bullet list (add/append type)
  const appendProposals = bulletProposals.filter(
    (p) => isAddProposal(p) && !removedProposalIds.has(p.id)
  );

  // Proposals indexed by bulletIndex (replace / delete)
  // { [bulletIndex]: (SuggestionItem|BulletProposal)[] }
  const bulletLevelProposals = {};
  for (const p of bulletProposals) {
    if (!isAddProposal(p) && !removedProposalIds.has(p.id)) {
      const bi = getBulletIndex(p);
      if (typeof bi === 'number') {
        if (!bulletLevelProposals[bi]) bulletLevelProposals[bi] = [];
        bulletLevelProposals[bi].push(p);
      }
    }
  }

  function handleProposalApproved(id) {
    setRemovedProposalIds((prev) => new Set([...prev, id]));
    onProposalApproved?.(id);
  }

  function handleProposalRejected(id) {
    setRemovedProposalIds((prev) => new Set([...prev, id]));
    onProposalRejected?.(id);
  }

  return (
    <div class={`rb-exp-item${_source === 'system' ? ' rb-item--unconfirmed' : ''}`}>
      <div class="rb-item-meta">
        <div class="rb-title-row">
          {title && <p class="rb-item-title">{title}</p>}
          <SourceBadge source={_source} />
        </div>
        <div class="rb-sub-row">
          <p class="rb-item-sub">
            {company}
            {loc && <span class="rb-meta-sep"> · {loc}</span>}
          </p>
          {period && <p class="rb-period">{period}</p>}
        </div>
      </div>
      {localBullets.length > 0 && (
        <ul class="rb-bullets">
          {localBullets.map((b, i) => (
            <BulletItem
              key={`exp-${itemIndex}-${i}`}
              text={b}
              section="experience"
              itemIndex={itemIndex}
              bulletIndex={i}
              onUpdated={onBulletAdded}
              onEditBullet={onBulletEdit}
              onDeleteBullet={onBulletDelete}
              proposals={bulletLevelProposals[i] ?? []}
              onProposalApproved={handleProposalApproved}
              onProposalRejected={handleProposalRejected}
              onResumeUpdated={onResumeUpdated}
            />
          ))}
        </ul>
      )}
      {/* ─── append_bullet 제안 (불릿 목록 아래 인라인 표시) ─── */}
      {appendProposals.length > 0 && (
        <div class="rb-proposals no-print" aria-label="불릿 추가 제안">
          {appendProposals.map((p) => (
            <BulletProposalChip
              key={p.id}
              proposal={p}
              onApproved={handleProposalApproved}
              onRejected={handleProposalRejected}
              onResumeUpdated={onResumeUpdated}
            />
          ))}
        </div>
      )}
      {/* ─── 새 bullet 추가 UI ─── */}
      <AddBulletArea
        section="experience"
        itemIndex={itemIndex}
        onAddBullet={onBulletAdd}
        onAdded={onBulletAdd
          ? undefined
          : (text) => {
              setLocalBullets((prev) => [...prev, text]);
              onBulletAdded?.();
            }
        }
      />
    </div>
  );
}

/**
 * 프로젝트 항목
 * schema: { name|title, description, url, bullets, tech_stack, _source }
 *
 * props:
 *   proj               — 프로젝트 항목 객체
 *   itemIndex          — projects 배열에서의 0-based 인덱스 (API 호출에 사용)
 *   onBulletAdded      — (선택, 레거시) bullet 추가 성공 후 fallback 콜백
 *   onBulletAdd        — (선택) bullet 추가 액션 핸들러 (section, itemIndex, bullet)
 *   onBulletEdit       — (선택) bullet 편집 액션 핸들러 (section, itemIndex, bulletIndex, text)
 *   onBulletDelete     — (선택) bullet 삭제 액션 핸들러 (section, itemIndex, bulletIndex)
 *   bulletProposals    — (선택) 이 항목에 해당하는 불릿 단위 제안 목록
 *   onProposalApproved — (선택) 제안 승인 완료 콜백 (id: string) => void
 *   onProposalRejected — (선택) 제안 제외 완료 콜백 (id: string) => void
 *   onResumeUpdated    — (선택) 이력서 변경 시 재조회 요청 콜백
 */
function ProjectItem({
  proj,
  itemIndex,
  onBulletAdded,
  onBulletAdd,
  onBulletEdit,
  onBulletDelete,
  bulletProposals = [],
  onProposalApproved,
  onProposalRejected,
  onResumeUpdated,
}) {
  const {
    title = '',
    name = '',
    description = '',
    url = '',
    tech_stack = [],
    bullets = [],
    _source,
  } = proj;
  const displayName = title || name;

  // Local bullet state — optimistically updated after API success
  const [localBullets, setLocalBullets] = useState([...bullets]);
  // Locally removed proposal IDs (after approve/reject)
  const [removedProposalIds, setRemovedProposalIds] = useState(() => new Set());

  // Sync when the parent resume object is refreshed
  useEffect(() => {
    setLocalBullets(Array.isArray(bullets) ? [...bullets] : []);
  }, [bullets]);

  // Helper: is this proposal an "add/append" type?
  function isAddProposal(p) {
    return p.kind === 'bullet' ? p.op === 'add' : p.action === 'append_bullet';
  }

  // Helper: get the bullet index for replace/delete proposals
  function getBulletIndex(p) {
    if (p.kind === 'bullet') return p.target?.bulletIndex;
    return p.patch?.bulletIndex;
  }

  // Proposals to render after the bullet list (add/append type)
  const appendProposals = bulletProposals.filter(
    (p) => isAddProposal(p) && !removedProposalIds.has(p.id)
  );

  // Proposals indexed by bulletIndex (replace / delete)
  const bulletLevelProposals = {};
  for (const p of bulletProposals) {
    if (!isAddProposal(p) && !removedProposalIds.has(p.id)) {
      const bi = getBulletIndex(p);
      if (typeof bi === 'number') {
        if (!bulletLevelProposals[bi]) bulletLevelProposals[bi] = [];
        bulletLevelProposals[bi].push(p);
      }
    }
  }

  function handleProposalApproved(id) {
    setRemovedProposalIds((prev) => new Set([...prev, id]));
    onProposalApproved?.(id);
  }

  function handleProposalRejected(id) {
    setRemovedProposalIds((prev) => new Set([...prev, id]));
    onProposalRejected?.(id);
  }

  return (
    <div class={`rb-proj-item${_source === 'system' ? ' rb-item--unconfirmed' : ''}`}>
      <div class="rb-proj-meta">
        <div class="rb-title-row">
          <p class="rb-item-title">
            {url
              ? <a href={url} target="_blank" rel="noopener noreferrer">{displayName}</a>
              : displayName
            }
          </p>
          <SourceBadge source={_source} />
        </div>
        {description && <p class="rb-item-sub rb-proj-desc">{description}</p>}
      </div>
      {tech_stack.length > 0 && (
        <div class="rb-skill-tags rb-proj-stack">
          {tech_stack.map((t, i) => (
            <span key={i} class="rb-skill-tag">{t}</span>
          ))}
        </div>
      )}
      {localBullets.length > 0 && (
        <ul class="rb-bullets">
          {localBullets.map((b, i) => (
            <BulletItem
              key={`proj-${itemIndex}-${i}`}
              text={b}
              section="projects"
              itemIndex={itemIndex}
              bulletIndex={i}
              onUpdated={onBulletAdded}
              onEditBullet={onBulletEdit}
              onDeleteBullet={onBulletDelete}
              proposals={bulletLevelProposals[i] ?? []}
              onProposalApproved={handleProposalApproved}
              onProposalRejected={handleProposalRejected}
              onResumeUpdated={onResumeUpdated}
            />
          ))}
        </ul>
      )}
      {/* ─── append_bullet 제안 (불릿 목록 아래 인라인 표시) ─── */}
      {appendProposals.length > 0 && (
        <div class="rb-proposals no-print" aria-label="불릿 추가 제안">
          {appendProposals.map((p) => (
            <BulletProposalChip
              key={p.id}
              proposal={p}
              onApproved={handleProposalApproved}
              onRejected={handleProposalRejected}
              onResumeUpdated={onResumeUpdated}
            />
          ))}
        </div>
      )}
      {/* ─── 새 bullet 추가 UI ─── */}
      <AddBulletArea
        section="projects"
        itemIndex={itemIndex}
        onAddBullet={onBulletAdd}
        onAdded={onBulletAdd
          ? undefined
          : (text) => {
              setLocalBullets((prev) => [...prev, text]);
              onBulletAdded?.();
            }
        }
      />
    </div>
  );
}

/**
 * 학력 항목
 * schema: { institution, degree, field, start_date, end_date, gpa, _source }
 */
function EducationItem({ edu }) {
  const {
    institution = '',
    degree = '',
    field = '',
    start_date = null,
    end_date = null,
    gpa = null,
    _source,
  } = edu;

  const period = formatPeriod(start_date, end_date);
  const degreeLabel = [degree, field].filter(Boolean).join(', ');

  return (
    <div class={`rb-edu-item${_source === 'system' ? ' rb-item--unconfirmed' : ''}`}>
      <div class="rb-title-row">
        {degreeLabel
          ? <p class="rb-item-title">{degreeLabel}</p>
          : <p class="rb-item-title rb-item-title--placeholder">학위 정보 없음</p>
        }
        <SourceBadge source={_source} />
      </div>
      <div class="rb-edu-meta">
        {institution && <span>{institution}</span>}
        {period && <span class="rb-period">{period}</span>}
        {gpa != null && <span>GPA {gpa}</span>}
      </div>
    </div>
  );
}

/**
 * 기술 섹션
 * schema: { technical: string[], languages: string[], tools: string[] }
 */
function SkillsSection({ skills }) {
  const groups = [
    { label: 'Technical', items: skills.technical ?? [] },
    { label: 'Languages', items: skills.languages ?? [] },
    { label: 'Tools',     items: skills.tools ?? [] },
  ].filter((g) => g.items.length > 0);

  if (groups.length === 0) return null;

  // 단일 그룹이면 카테고리 레이블 없이 flat tags
  if (groups.length === 1) {
    return (
      <div class="rb-skill-tags">
        {groups[0].items.map((s, i) => (
          <span key={i} class="rb-skill-tag">{s}</span>
        ))}
      </div>
    );
  }

  return (
    <div class="rb-skills-grouped">
      {groups.map((g, i) => (
        <div key={i} class="rb-skill-group">
          <p class="rb-skill-category">{g.label}</p>
          <div class="rb-skill-tags">
            {g.items.map((s, j) => (
              <span key={j} class="rb-skill-tag">{s}</span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * 자격증·수료 항목
 * schema: { name|title, issuer, date|issued_date, expiry_date, url, _source }
 */
function CertificationItem({ cert }) {
  const {
    title = '',
    name = '',
    issuer = '',
    date = '',
    issued_date = '',
    expiry_date = '',
    url = '',
    _source,
  } = cert;

  const displayName = title || name;
  const displayDate = issued_date || date;

  return (
    <div class={`rb-cert-item${_source === 'system' ? ' rb-item--unconfirmed' : ''}`}>
      <div class="rb-title-row">
        <p class="rb-item-title">
          {url
            ? <a href={url} target="_blank" rel="noopener noreferrer">{displayName}</a>
            : displayName
          }
        </p>
        <SourceBadge source={_source} />
      </div>
      <div class="rb-edu-meta">
        {issuer && <span>{issuer}</span>}
        {displayDate && (
          <span class="rb-period">
            {displayDate}
            {expiry_date ? ` – ${expiry_date}` : ''}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * 새 bullet 추가 UI
 *
 * 각 ExperienceItem / ProjectItem 하단에 렌더링되는 인라인 추가 UI.
 *
 * 상태 흐름:
 *   idle   → 버튼 클릭 → adding
 *   adding → 입력 후 "확정" 또는 Enter → saving → idle (성공) or error (실패)
 *   adding → "취소" 또는 Escape → idle
 *
 * props:
 *   section      — "experience" | "projects"  (API body 용)
 *   itemIndex    — 0-based 배열 인덱스        (API body 용)
 *   onAddBullet  — (선택) useResumeActions.addBullet 핸들러.
 *                  제공 시 이 함수로 API 호출 + 로컬 상태 갱신을 처리한다.
 *                  (section, itemIndex, bullet) => Promise<void>
 *   onAdded      — (선택, 레거시) onAddBullet이 없을 때 사용되는 fallback.
 *                  (text: string) => void — 성공 후 부모가 로컬 상태 업데이트
 */
function AddBulletArea({ section, itemIndex, onAddBullet, onAdded }) {
  const [phase, setPhase] = useState('idle'); // 'idle' | 'adding' | 'saving'
  const [text, setText] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const textareaRef = useRef(null);

  // 텍스트 에리어가 마운트되면 자동 포커스
  useEffect(() => {
    if (phase === 'adding' && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [phase]);

  function openForm() {
    setText('');
    setErrorMsg('');
    setPhase('adding');
  }

  function cancel() {
    setText('');
    setErrorMsg('');
    setPhase('idle');
  }

  async function confirm() {
    const trimmed = text.trim();
    if (!trimmed) return;

    setPhase('saving');
    setErrorMsg('');

    try {
      if (onAddBullet) {
        // ── Sub-AC 8-3: useResumeActions 핸들러 경로 ────────────────────────
        // API 호출 + 응답 resume으로 상위 상태 즉시 갱신 (GET 재조회 없음).
        await onAddBullet(section, itemIndex, trimmed);
      } else {
        // ── 레거시 경로: 직접 fetch + onAdded 콜백 ─────────────────────────
        const res = await fetch('/api/resume/section-bullet', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ section, itemIndex, bullet: trimmed }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }

        onAdded?.(trimmed);
      }

      setText('');
      setPhase('idle');
    } catch (err) {
      console.error('[AddBulletArea] save failed:', err);
      setErrorMsg(err.message || '저장에 실패했습니다.');
      setPhase('adding'); // 폼 유지 (에러 메시지 표시)
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      confirm();
    }
    if (e.key === 'Escape') {
      cancel();
    }
  }

  const isSaving = phase === 'saving';

  return (
    <div class="rb-add-bullet no-print">
      {phase === 'idle' && (
        <button
          class="rb-add-bullet-trigger"
          type="button"
          onClick={openForm}
          aria-label="새 bullet 추가"
        >
          + bullet 추가
        </button>
      )}

      {(phase === 'adding' || phase === 'saving') && (
        <div class="rb-add-bullet-form" role="group" aria-label="새 bullet 입력">
          <textarea
            ref={textareaRef}
            class="rb-add-bullet-input"
            placeholder="새 bullet 내용을 입력하세요 (Enter로 확정, Shift+Enter 줄바꿈, Esc로 취소)"
            value={text}
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            disabled={isSaving}
            rows={2}
            maxLength={500}
            aria-label="새 bullet 텍스트"
          />
          {errorMsg && (
            <p class="rb-add-bullet-error" role="alert">{errorMsg}</p>
          )}
          <div class="rb-add-bullet-actions">
            <button
              class="rb-add-bullet-confirm"
              type="button"
              onClick={confirm}
              disabled={!text.trim() || isSaving}
              aria-busy={isSaving}
            >
              {isSaving ? '저장 중…' : '확정'}
            </button>
            <button
              class="rb-add-bullet-cancel"
              type="button"
              onClick={cancel}
              disabled={isSaving}
            >
              취소
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * BulletItem — 단일 bullet 항목의 인라인 편집·삭제 컴포넌트.
 *
 * 보기 모드: 텍스트 + 마우스오버 시 [편집] [삭제] 버튼 표시 (인쇄 제외)
 * 편집 모드: 텍스트에어리어 + [저장] [취소] 버튼
 * 삭제 확인 모드: 삭제 전 "삭제 확인/취소" 이중 확인 UI (실수 방지)
 *
 * 편집/삭제 성공:
 *   - onEditBullet / onDeleteBullet(Sub-AC 8-3) 제공 시: 핸들러가 API 호출 +
 *     응답 resume으로 로컬 상태를 즉시 갱신 (GET 재조회 없음).
 *   - 없을 시 레거시 경로: 직접 fetch 후 onUpdated() 호출 (full re-fetch).
 *
 * 사용자 수정은 시스템 merge보다 항상 우선 (_source: 'user' 처리는 백엔드에서 수행).
 *
 * 불릿 단위 제안:
 *   proposals 배열에 replace_bullet / delete_bullet 제안이 있으면
 *   해당 bullet 아래에 BulletProposalChip으로 표시된다.
 *   사용자는 제안을 승인·제외하거나 인라인으로 수정할 수 있다.
 *   (인라인 직접 편집은 제안 없이 바로 PATCH를 수행하며 replace 제안을 생성하지 않는다)
 *
 * props:
 *   text               — bullet 텍스트 문자열
 *   section            — 'experience' | 'projects'
 *   itemIndex          — resume[section] 배열에서의 0-based 인덱스
 *   bulletIndex        — resume[section][itemIndex].bullets 배열에서의 0-based 인덱스
 *   onUpdated          — (선택, 레거시) 편집/삭제 성공 후 이력서 재조회 트리거 콜백
 *   onEditBullet       — (선택) useResumeActions.editBullet 핸들러.
 *                        (section, itemIndex, bulletIndex, text) => Promise<void>
 *   onDeleteBullet     — (선택) useResumeActions.deleteBullet 핸들러.
 *                        (section, itemIndex, bulletIndex) => Promise<void>
 *   proposals          — (선택) 이 bullet에 대한 제안 목록 (replace_bullet / delete_bullet)
 *   onProposalApproved — (선택) 제안 승인 완료 콜백 (id: string) => void
 *   onProposalRejected — (선택) 제안 제외 완료 콜백 (id: string) => void
 *   onResumeUpdated    — (선택) 제안 승인으로 이력서 변경 시 재조회 요청 콜백
 */
function BulletItem({
  text,
  section,
  itemIndex,
  bulletIndex,
  onUpdated,
  onEditBullet,
  onDeleteBullet,
  proposals = [],
  onProposalApproved,
  onProposalRejected,
  onResumeUpdated,
}) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const textareaRef = useRef(null);

  // 편집 모드 진입 시 textarea 자동 포커스
  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      const len = textareaRef.current.value.length;
      textareaRef.current.setSelectionRange(len, len);
    }
  }, [editing]);

  // 부모 재조회 후 props가 바뀌면 내부 상태 리셋
  useEffect(() => {
    setEditText(text);
    setEditing(false);
    setSaving(false);
    setError('');
    setDeleteConfirm(false);
  }, [text]);

  function handleEditStart() {
    setEditText(text);
    setEditing(true);
    setError('');
    setDeleteConfirm(false);
  }

  function handleCancel() {
    setEditing(false);
    setError('');
  }

  async function handleSave() {
    const trimmed = editText.trim();
    if (!trimmed) {
      setError('내용을 입력하세요.');
      return;
    }
    if (trimmed === text.trim()) {
      // 변경 없음 → 그냥 닫기
      setEditing(false);
      return;
    }
    setSaving(true);
    setError('');
    try {
      if (onEditBullet) {
        // ── Sub-AC 8-3: useResumeActions 핸들러 경로 ────────────────────────
        // API 호출 + 응답 resume으로 상위 상태 즉시 갱신 (GET 재조회 없음).
        await onEditBullet(section, itemIndex, bulletIndex, trimmed);
      } else {
        // ── 레거시 경로: 직접 fetch + onUpdated 콜백 ────────────────────────
        const res = await fetch(
          `/api/resume/sections/${section}/${itemIndex}/bullets/${bulletIndex}`,
          {
            method: 'PATCH',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: trimmed }),
          }
        );
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        onUpdated?.();
      }
      setEditing(false);
    } catch (err) {
      console.error('[BulletItem] save failed:', err);
      setError(err.message || '저장에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteConfirm) {
      // 첫 번째 클릭 → 확인 UI 표시
      setDeleteConfirm(true);
      setError('');
      return;
    }
    // 두 번째 클릭 → 실제 삭제
    setSaving(true);
    setError('');
    try {
      if (onDeleteBullet) {
        // ── Sub-AC 8-3: useResumeActions 핸들러 경로 ────────────────────────
        // API 호출 + 응답 resume으로 상위 상태 즉시 갱신 (GET 재조회 없음).
        await onDeleteBullet(section, itemIndex, bulletIndex);
      } else {
        // ── 레거시 경로: 직접 fetch + onUpdated 콜백 ────────────────────────
        const res = await fetch(
          `/api/resume/sections/${section}/${itemIndex}/bullets/${bulletIndex}`,
          { method: 'DELETE', credentials: 'include' }
        );
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        onUpdated?.();
      }
    } catch (err) {
      console.error('[BulletItem] delete failed:', err);
      setError(err.message || '삭제에 실패했습니다.');
      setDeleteConfirm(false);
    } finally {
      setSaving(false);
    }
  }

  function handleCancelDelete() {
    setDeleteConfirm(false);
    setError('');
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') handleCancel();
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSave();
    }
  }

  // ─── 편집 모드 ───────────────────────────────────────────────────────────
  if (editing) {
    return (
      <li class="rb-bullet-item rb-bullet-item--editing">
        <textarea
          ref={textareaRef}
          class="rb-bullet-edit-input"
          value={editText}
          onInput={(e) => setEditText(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          disabled={saving}
          rows={2}
          maxLength={500}
          aria-label="bullet 텍스트 편집"
        />
        {error && <span class="rb-bullet-error" role="alert">{error}</span>}
        <div class="rb-bullet-edit-actions no-print">
          <button
            class="rb-bullet-save-btn"
            type="button"
            onClick={handleSave}
            disabled={saving || !editText.trim()}
            aria-busy={saving}
          >
            {saving ? '저장 중…' : '저장'}
          </button>
          <button
            class="rb-bullet-cancel-btn"
            type="button"
            onClick={handleCancel}
            disabled={saving}
          >
            취소
          </button>
        </div>
      </li>
    );
  }

  // ─── 삭제 확인 모드 ──────────────────────────────────────────────────────
  if (deleteConfirm) {
    return (
      <li class="rb-bullet-item rb-bullet-item--confirm-delete">
        <span class="rb-bullet-text rb-bullet-text--muted">{text}</span>
        <span class="rb-bullet-confirm-msg no-print">이 항목을 삭제하시겠습니까?</span>
        <div class="rb-bullet-edit-actions no-print">
          <button
            class="rb-bullet-del-confirm-btn"
            type="button"
            onClick={handleDelete}
            disabled={saving}
            aria-busy={saving}
          >
            {saving ? '삭제 중…' : '삭제 확인'}
          </button>
          <button
            class="rb-bullet-cancel-btn"
            type="button"
            onClick={handleCancelDelete}
            disabled={saving}
          >
            취소
          </button>
        </div>
        {error && <span class="rb-bullet-error" role="alert">{error}</span>}
      </li>
    );
  }

  // ─── 기본 보기 모드 ───────────────────────────────────────────────────────
  return (
    <li class="rb-bullet-item">
      <span class="rb-bullet-text">{text}</span>
      <span class="rb-bullet-actions no-print">
        <button
          class="rb-bullet-edit-btn"
          type="button"
          onClick={handleEditStart}
          disabled={saving}
          aria-label="bullet 편집"
          title="편집"
        >
          편집
        </button>
        <button
          class="rb-bullet-del-btn"
          type="button"
          onClick={handleDelete}
          disabled={saving}
          aria-label="bullet 삭제"
          title="삭제"
        >
          삭제
        </button>
      </span>
      {error && <span class="rb-bullet-error" role="alert">{error}</span>}
      {/* ─── replace_bullet / delete_bullet 제안 (이 bullet에 대한 제안) ─── */}
      {proposals.length > 0 && (
        <div class="rb-bullet-proposals no-print">
          {proposals.map((p) => (
            <BulletProposalChip
              key={p.id}
              proposal={p}
              onApproved={onProposalApproved}
              onRejected={onProposalRejected}
              onResumeUpdated={onResumeUpdated}
            />
          ))}
        </div>
      )}
    </li>
  );
}

/**
 * 강점 키워드 섹션 (비정형 누적 목록)
 *
 * - 현재 keywords를 removable tag chips으로 표시한다.
 * - 텍스트 입력으로 새 키워드를 추가한다 (Enter 또는 쉼표 구분).
 * - 변경 시 PATCH /api/resume/strength-keywords를 즉시 호출한다.
 * - 인쇄 시 전체 섹션이 숨겨진다 (display_axes가 인쇄용 서사를 담당).
 * - 부모가 새 resume을 내려보내면 (fetchResume 후) 내부 상태가 동기화된다.
 *
 * props:
 *   initialKeywords — resume.strength_keywords (string[])
 */
function StrengthKeywordsSection({ initialKeywords }) {
  const [keywords, setKeywords] = useState(
    Array.isArray(initialKeywords) ? [...initialKeywords] : []
  );
  const [inputValue, setInputValue] = useState('');
  // 'idle' | 'saving' | 'saved' | 'error'
  const [saveStatus, setSaveStatus] = useState('idle');

  // Sync state when parent resume is refreshed (e.g. after suggestion approval)
  useEffect(() => {
    setKeywords(Array.isArray(initialKeywords) ? [...initialKeywords] : []);
  }, [initialKeywords]);

  async function save(newKeywords) {
    setSaveStatus('saving');
    try {
      const res = await fetch('/api/resume/strength-keywords', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords: newKeywords }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (err) {
      console.error('[StrengthKeywords] save failed:', err);
      setSaveStatus('error');
      setTimeout(() => setSaveStatus('idle'), 3000);
    }
  }

  function removeKeyword(kw) {
    const updated = keywords.filter((k) => k !== kw);
    setKeywords(updated);
    save(updated);
  }

  function addFromInput() {
    if (!inputValue.trim()) return;

    // Support comma-separated batch input
    const toAdd = inputValue
      .split(',')
      .map((s) => s.trim().slice(0, 40))
      .filter((s) => s.length > 0);

    if (toAdd.length === 0) {
      setInputValue('');
      return;
    }

    const existingLower = new Set(keywords.map((k) => k.toLowerCase()));
    const newOnes = toAdd.filter((k) => !existingLower.has(k.toLowerCase()));

    setInputValue('');

    if (newOnes.length === 0) return; // all duplicates — skip save

    const updated = [...keywords, ...newOnes];
    setKeywords(updated);
    save(updated);
  }

  function handleInputKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      addFromInput();
    }
  }

  return (
    <section class="rb-section rb-kw-section-wrap no-print" aria-label="강점 키워드">
      <div class="rb-section-heading">
        <p class="rb-kicker">STRENGTH KEYWORDS</p>
        <div class="rb-title-row">
          <h2 class="rb-section-title">강점 키워드</h2>
          {saveStatus === 'saving' && (
            <span class="rb-kw-status rb-kw-status--saving">저장 중…</span>
          )}
          {saveStatus === 'saved' && (
            <span class="rb-kw-status rb-kw-status--saved">저장됨</span>
          )}
          {saveStatus === 'error' && (
            <span class="rb-kw-status rb-kw-status--error">저장 실패</span>
          )}
        </div>
      </div>

      <div class="rb-kw-body">
        {/* Existing keyword tags */}
        <div class="rb-kw-tags">
          {keywords.map((kw, i) => (
            <span key={kw + i} class="rb-kw-tag">
              <span class="rb-kw-text">{kw}</span>
              <button
                class="rb-kw-remove"
                type="button"
                onClick={() => removeKeyword(kw)}
                aria-label={`"${kw}" 삭제`}
                title={`"${kw}" 삭제`}
              >
                ×
              </button>
            </span>
          ))}
        </div>

        {/* Add new keywords */}
        <div class="rb-kw-add-row">
          <input
            class="rb-kw-input"
            type="text"
            placeholder="키워드 추가 (Enter 또는 쉼표로 구분)"
            value={inputValue}
            onInput={(e) => setInputValue(e.currentTarget.value)}
            onKeyDown={handleInputKeyDown}
            maxLength={120}
            aria-label="새 강점 키워드 입력"
          />
          {inputValue.trim() && (
            <button
              class="rb-kw-add-btn"
              type="button"
              onClick={addFromInput}
              aria-label="키워드 추가"
            >
              추가
            </button>
          )}
        </div>

        {keywords.length === 0 && !inputValue && (
          <p class="rb-kw-empty">
            강점 키워드가 없습니다. 위 입력란에 키워드를 입력하세요.
          </p>
        )}
      </div>
    </section>
  );
}

/* ──────────────────────────────────────────── */
/* Helpers                                      */
/* ──────────────────────────────────────────── */

/** ISO / "YYYY-MM" 날짜를 한국어 짧은 날짜 형식으로 변환 */
function formatDate(value) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleDateString('ko-KR', {
      year: 'numeric',
      month: 'long',
    });
  } catch {
    return String(value);
  }
}

/**
 * start_date / end_date → "YYYY.MM – YYYY.MM" 또는 "YYYY.MM – 현재".
 * 두 값 모두 null 이면 빈 문자열 반환.
 */
function formatPeriod(start, end) {
  if (!start && !end) return '';

  function toLabel(val) {
    if (!val) return null;
    if (/^\d{4}-\d{2}$/.test(val)) {
      const [y, m] = val.split('-');
      return `${y}.${m}`;
    }
    try {
      const d = new Date(val);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      return `${y}.${m}`;
    } catch {
      return String(val);
    }
  }

  const s = start ? toLabel(start) : null;
  const e = end ? toLabel(end) : '현재';

  if (s && e) return `${s} – ${e}`;
  if (s) return `${s} – 현재`;
  return e ?? '';
}

/* ──────────────────────────────────────────── */
/* Styles                                       */
/* ──────────────────────────────────────────── */

const RB_CSS = `
  /* ─── Body card ─── */
  .rb-body {
    background: var(--panel);
    border: 1px solid var(--line);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow);
    padding: var(--space-7) var(--space-6);
    backdrop-filter: blur(10px);
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }

  /* ─── Full-card states (loading / empty) ─── */
  .rb-state {
    min-height: 320px;
    align-items: center;
    justify-content: center;
  }

  .rb-empty-msg {
    margin: 0;
    font-size: 14px;
    color: var(--muted);
  }

  /* ─── Skeleton loading ─── */
  .rb-skeleton {
    border-radius: var(--radius-sm);
    background: linear-gradient(
      90deg,
      rgba(17, 24, 39, 0.06) 25%,
      rgba(17, 24, 39, 0.12) 50%,
      rgba(17, 24, 39, 0.06) 75%
    );
    background-size: 200% 100%;
    animation: rb-shimmer 1.4s ease-in-out infinite;
  }

  @keyframes rb-shimmer {
    0%   { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }

  .rb-skeleton--name    { height: 36px; width: 40%; margin-bottom: 8px; }
  .rb-skeleton--contact { height: 14px; width: 60%; }
  .rb-skeleton--kicker  { height: 10px; width: 15%; }
  .rb-skeleton--title   { height: 16px; width: 50%; }
  .rb-skeleton--line    { height: 13px; width: 100%; }
  .rb-skeleton--short   { width: 75%; }

  .rb-skeleton-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /* ─── Divider ─── */
  .rb-divider {
    height: 1px;
    background: var(--line);
    margin: 0;
  }

  /* ─── Contact header ─── */
  .rb-name {
    margin: 0 0 var(--space-2);
    font-size: clamp(22px, 4vw, 34px);
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--ink);
  }

  .rb-name--placeholder {
    color: var(--muted);
    font-weight: 400;
    font-style: italic;
  }

  .rb-contact {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2) var(--space-4);
    font-size: 13px;
    color: var(--muted);
  }

  .rb-contact a {
    color: var(--muted);
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  /* ─── Section ─── */
  .rb-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .rb-section-heading {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .rb-kicker {
    margin: 0;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--muted);
  }

  .rb-section-title {
    margin: 0;
    font-size: 16px;
    font-weight: 700;
    color: var(--ink);
    letter-spacing: -0.01em;
  }

  /* ─── Title row (title + source badge side by side) ─── */
  .rb-title-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  /* Sub-row for company/period spread apart */
  .rb-sub-row {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  /* ─── Common item layout ─── */
  .rb-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  .rb-item-meta {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .rb-item-title {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    color: var(--ink);
  }

  .rb-item-title--placeholder {
    color: var(--muted);
    font-style: italic;
  }

  .rb-item-sub {
    margin: 0;
    font-size: 13px;
    color: var(--muted);
  }

  /* ─── Experience ─── */
  .rb-exp-item {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  /* ─── Projects ─── */
  .rb-proj-item {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .rb-proj-meta {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .rb-item-title a {
    text-decoration: underline;
    text-underline-offset: 2px;
  }

  .rb-proj-desc {
    font-size: 13px;
  }

  .rb-proj-stack {
    margin-top: var(--space-1);
  }

  /* ─── Education ─── */
  .rb-edu-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .rb-edu-meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    font-size: 13px;
    color: var(--muted);
  }

  /* ─── Certifications ─── */
  .rb-cert-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  /* ─── Shared: bullets + period + meta-sep ─── */
  .rb-bullets {
    margin: 0;
    padding-left: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: 4px;
    list-style: disc;
    font-size: 13px;
    line-height: 1.65;
    color: var(--ink);
  }

  .rb-period {
    white-space: nowrap;
    flex-shrink: 0;
    font-size: 12px;
    color: var(--muted);
  }

  .rb-meta-sep {
    color: var(--muted);
  }

  /* ─── Summary ─── */
  .rb-summary {
    margin: 0;
    font-size: 14px;
    line-height: 1.75;
    color: var(--ink);
  }

  /* ─── Skills ─── */
  .rb-skills-grouped {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .rb-skill-group {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .rb-skill-category {
    margin: 0;
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .rb-skill-tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .rb-skill-tag {
    padding: 4px 10px;
    font-size: 12px;
    font-weight: 500;
    background: rgba(17, 24, 39, 0.06);
    border-radius: var(--radius-sm);
    color: var(--ink);
  }

  /* ─── Source provenance badges ─── */
  .rb-source-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 6px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    border-radius: 4px;
    flex-shrink: 0;
    cursor: default;
    user-select: none;
  }

  /* 배지 앞 아이콘 (✎ ✓ ●) */
  .rb-source-badge-icon {
    font-size: 9px;
    line-height: 1;
    font-style: normal;
    flex-shrink: 0;
  }

  /* system source → 미반영: 주황 계열 — 사용자 확인이 필요한 상태 */
  .rb-source-badge--system {
    background: rgba(245, 158, 11, 0.10);
    color: #b45309;
    border: 1px solid rgba(245, 158, 11, 0.30);
  }

  .rb-source-badge--user {
    background: rgba(59, 130, 246, 0.10);
    color: #2563eb;
    border: 1px solid rgba(59, 130, 246, 0.25);
  }

  .rb-source-badge--approved {
    background: rgba(16, 185, 129, 0.10);
    color: #059669;
    border: 1px solid rgba(16, 185, 129, 0.25);
  }

  /* ─── 미반영 항목 (system source) 시각적 구분 ─── */
  /*
   * 왼쪽 주황 보더로 "아직 사용자가 확인하지 않은 시스템 자동 생성 항목"임을 표시.
   * 인쇄 시 border/padding은 제거한다 (아래 @media print 참조).
   */
  .rb-item--unconfirmed {
    padding-left: calc(var(--space-3) + 2px);
    border-left: 2px solid rgba(245, 158, 11, 0.40);
  }

  /* ─── Source note ─── */
  .rb-source-note {
    margin: 0;
    font-size: 11px;
    color: var(--muted);
    opacity: 0.65;
  }

  /* ─── Strength Keywords section ─── */
  .rb-kw-section-wrap {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .rb-kw-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  /* Tag cloud */
  .rb-kw-tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    min-height: 28px;
  }

  .rb-kw-tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 6px 4px 10px;
    font-size: 12px;
    font-weight: 500;
    background: rgba(59, 130, 246, 0.08);
    border: 1px solid rgba(59, 130, 246, 0.22);
    border-radius: var(--radius-sm);
    color: #1d4ed8;
    transition: background 0.1s;
  }

  .rb-kw-tag:hover {
    background: rgba(59, 130, 246, 0.14);
  }

  .rb-kw-text {
    line-height: 1.3;
  }

  .rb-kw-remove {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    padding: 0;
    font-size: 13px;
    line-height: 1;
    background: none;
    border: none;
    color: #1d4ed8;
    opacity: 0.55;
    cursor: pointer;
    border-radius: 2px;
    transition: opacity 0.15s, background 0.1s;
    flex-shrink: 0;
  }

  .rb-kw-remove:hover {
    opacity: 1;
    background: rgba(59, 130, 246, 0.18);
  }

  /* Add-row: input + button */
  .rb-kw-add-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .rb-kw-input {
    flex: 1 1 180px;
    min-width: 160px;
    max-width: 300px;
    padding: 5px 10px;
    font-size: 12px;
    font-family: inherit;
    background: transparent;
    border: 1px dashed var(--line);
    border-radius: var(--radius-sm);
    color: var(--ink);
    outline: none;
    transition: border-color 0.15s, border-style 0.15s;
  }

  .rb-kw-input:focus {
    border-style: solid;
    border-color: rgba(59, 130, 246, 0.6);
  }

  .rb-kw-input::placeholder {
    color: var(--muted);
    opacity: 0.55;
  }

  .rb-kw-add-btn {
    padding: 5px 12px;
    font-size: 12px;
    font-weight: 600;
    font-family: inherit;
    background: rgba(59, 130, 246, 0.10);
    border: 1px solid rgba(59, 130, 246, 0.25);
    border-radius: var(--radius-sm);
    color: #1d4ed8;
    cursor: pointer;
    transition: background 0.15s, opacity 0.15s;
    white-space: nowrap;
  }

  .rb-kw-add-btn:hover {
    background: rgba(59, 130, 246, 0.18);
  }

  /* Save status indicator */
  .rb-kw-status {
    font-size: 11px;
    font-weight: 500;
    margin-left: var(--space-2);
  }

  .rb-kw-status--saving { color: var(--muted); }
  .rb-kw-status--saved  { color: #16a34a; }
  .rb-kw-status--error  { color: #dc2626; }

  /* Empty state hint */
  .rb-kw-empty {
    margin: 0;
    font-size: 12px;
    color: var(--muted);
    font-style: italic;
  }

  /* ─── 새 bullet 추가 UI ─── */

  /* Wrapper — always rendered but hidden in print via .no-print */
  .rb-add-bullet {
    margin-top: var(--space-2);
  }

  /* Trigger button: subtle ghost link style */
  .rb-add-bullet-trigger {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    font-size: 11px;
    font-weight: 500;
    font-family: inherit;
    color: var(--muted);
    background: transparent;
    border: 1px dashed transparent;
    border-radius: var(--radius-sm);
    opacity: 0;
    transition: opacity 0.15s, color 0.15s, border-color 0.15s, background 0.1s;
    cursor: pointer;
  }

  /* Show trigger on parent item hover */
  .rb-exp-item:hover .rb-add-bullet-trigger,
  .rb-proj-item:hover .rb-add-bullet-trigger {
    opacity: 1;
  }

  .rb-add-bullet-trigger:focus-visible {
    opacity: 1;
    outline: 2px solid rgba(59, 130, 246, 0.5);
    outline-offset: 2px;
  }

  .rb-add-bullet-trigger:hover {
    color: #2563eb;
    border-color: rgba(59, 130, 246, 0.35);
    background: rgba(59, 130, 246, 0.06);
  }

  /* Inline form */
  .rb-add-bullet-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  /* Textarea */
  .rb-add-bullet-input {
    width: 100%;
    box-sizing: border-box;
    padding: 7px 10px;
    font-size: 13px;
    font-family: inherit;
    line-height: 1.55;
    color: var(--ink);
    background: transparent;
    border: 1px dashed var(--line);
    border-radius: var(--radius-sm);
    outline: none;
    resize: vertical;
    min-height: 52px;
    transition: border-color 0.15s, border-style 0.15s;
  }

  .rb-add-bullet-input:focus {
    border-style: solid;
    border-color: rgba(59, 130, 246, 0.55);
  }

  .rb-add-bullet-input::placeholder {
    color: var(--muted);
    opacity: 0.55;
    font-size: 12px;
  }

  .rb-add-bullet-input:disabled {
    opacity: 0.55;
  }

  /* Error message */
  .rb-add-bullet-error {
    margin: 0;
    font-size: 12px;
    color: #dc2626;
  }

  /* Actions row */
  .rb-add-bullet-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  /* Confirm button */
  .rb-add-bullet-confirm {
    padding: 4px 12px;
    font-size: 12px;
    font-weight: 600;
    font-family: inherit;
    background: rgba(59, 130, 246, 0.10);
    border: 1px solid rgba(59, 130, 246, 0.28);
    border-radius: var(--radius-sm);
    color: #1d4ed8;
    cursor: pointer;
    transition: background 0.15s, opacity 0.15s;
    white-space: nowrap;
  }

  .rb-add-bullet-confirm:hover:not(:disabled) {
    background: rgba(59, 130, 246, 0.18);
  }

  .rb-add-bullet-confirm:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  /* Cancel button */
  .rb-add-bullet-cancel {
    padding: 4px 10px;
    font-size: 12px;
    font-weight: 500;
    font-family: inherit;
    background: transparent;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    color: var(--muted);
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
    white-space: nowrap;
  }

  .rb-add-bullet-cancel:hover:not(:disabled) {
    color: var(--ink);
    border-color: rgba(17, 24, 39, 0.25);
  }

  .rb-add-bullet-cancel:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  /* ─── BulletItem (인라인 편집·삭제) ─── */

  /* 기본 보기 모드: 텍스트와 액션 버튼을 한 줄에 배치 */
  .rb-bullet-item {
    display: flex;
    flex-direction: row;
    align-items: flex-start;
    flex-wrap: wrap;
    gap: 4px;
    padding: 1px 0;
    /* list-style(disc)은 .rb-bullets에서 상속 */
  }

  /* 편집/삭제확인 모드는 column 방향 */
  .rb-bullet-item--editing,
  .rb-bullet-item--confirm-delete {
    flex-direction: column;
    align-items: stretch;
  }

  .rb-bullet-text {
    flex: 1 1 auto;
    min-width: 0;
  }

  .rb-bullet-text--muted {
    opacity: 0.45;
  }

  /* 액션 버튼 그룹: 기본 숨김, hover 시 표시 */
  .rb-bullet-actions {
    display: none;
    align-items: center;
    gap: var(--space-1);
    flex-shrink: 0;
    margin-top: 1px; /* 시각적 정렬 */
  }

  .rb-bullet-item:hover > .rb-bullet-actions {
    display: inline-flex;
  }

  /* 편집 / 삭제 버튼 공통 */
  .rb-bullet-edit-btn,
  .rb-bullet-del-btn,
  .rb-bullet-del-confirm-btn {
    display: inline-flex;
    align-items: center;
    padding: 1px 6px;
    font-size: 11px;
    font-weight: 500;
    font-family: inherit;
    line-height: 1.4;
    border-radius: 3px;
    border: 1px solid transparent;
    cursor: pointer;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
    white-space: nowrap;
  }

  .rb-bullet-edit-btn {
    background: rgba(17, 24, 39, 0.05);
    border-color: rgba(17, 24, 39, 0.12);
    color: var(--muted);
  }

  .rb-bullet-edit-btn:hover:not(:disabled) {
    background: rgba(17, 24, 39, 0.10);
    border-color: rgba(17, 24, 39, 0.22);
    color: var(--ink);
  }

  .rb-bullet-del-btn {
    background: rgba(220, 38, 38, 0.06);
    border-color: rgba(220, 38, 38, 0.15);
    color: #b91c1c;
  }

  .rb-bullet-del-btn:hover:not(:disabled) {
    background: rgba(220, 38, 38, 0.12);
    border-color: rgba(220, 38, 38, 0.30);
  }

  .rb-bullet-del-confirm-btn {
    background: rgba(220, 38, 38, 0.10);
    border-color: rgba(220, 38, 38, 0.30);
    color: #dc2626;
    font-weight: 600;
  }

  .rb-bullet-del-confirm-btn:hover:not(:disabled) {
    background: rgba(220, 38, 38, 0.18);
  }

  .rb-bullet-edit-btn:disabled,
  .rb-bullet-del-btn:disabled,
  .rb-bullet-del-confirm-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  /* 편집 textarea */
  .rb-bullet-edit-input {
    width: 100%;
    box-sizing: border-box;
    padding: 5px 8px;
    font-size: 13px;
    font-family: inherit;
    line-height: 1.65;
    color: var(--ink);
    background: transparent;
    border: 1px solid rgba(59, 130, 246, 0.40);
    border-radius: var(--radius-sm);
    resize: vertical;
    outline: none;
    transition: border-color 0.15s;
  }

  .rb-bullet-edit-input:focus {
    border-color: rgba(59, 130, 246, 0.70);
  }

  .rb-bullet-edit-input:disabled {
    opacity: 0.6;
    cursor: not-allowed;
    resize: none;
  }

  /* 편집 모드 버튼 행 */
  .rb-bullet-edit-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  /* 저장 버튼 */
  .rb-bullet-save-btn {
    padding: 3px 10px;
    font-size: 12px;
    font-weight: 600;
    font-family: inherit;
    background: rgba(59, 130, 246, 0.10);
    border: 1px solid rgba(59, 130, 246, 0.25);
    border-radius: var(--radius-sm);
    color: #1d4ed8;
    cursor: pointer;
    transition: background 0.12s;
    white-space: nowrap;
  }

  .rb-bullet-save-btn:hover:not(:disabled) {
    background: rgba(59, 130, 246, 0.18);
  }

  .rb-bullet-save-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  /* 취소 버튼 (편집 모드 & 삭제 확인 모드 공유) */
  .rb-bullet-cancel-btn {
    padding: 3px 10px;
    font-size: 12px;
    font-weight: 500;
    font-family: inherit;
    background: transparent;
    border: 1px solid rgba(17, 24, 39, 0.15);
    border-radius: var(--radius-sm);
    color: var(--muted);
    cursor: pointer;
    transition: color 0.12s, border-color 0.12s;
    white-space: nowrap;
  }

  .rb-bullet-cancel-btn:hover:not(:disabled) {
    color: var(--ink);
    border-color: rgba(17, 24, 39, 0.25);
  }

  .rb-bullet-cancel-btn:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  /* 삭제 확인 메시지 */
  .rb-bullet-confirm-msg {
    font-size: 12px;
    color: #dc2626;
    font-weight: 500;
    line-height: 1.4;
  }

  /* 에러 메시지 */
  .rb-bullet-error {
    font-size: 11px;
    color: #dc2626;
    line-height: 1.4;
  }

  /* ─── Inline proposal containers ─── */

  /* append_bullet proposals — rendered after bullet list inside ExperienceItem/ProjectItem */
  .rb-proposals {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 4px;
    padding-left: 0;
  }

  /* replace_bullet / delete_bullet proposals — rendered inside BulletItem */
  .rb-bullet-proposals {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin-top: 3px;
    /* Indent to align with bullet text */
    padding-left: 4px;
  }

  /* Show add-bullet trigger when parent item is unconfirmed + hovered */
  .rb-item--unconfirmed:hover .rb-add-bullet-trigger {
    opacity: 1;
  }

  /* ─── Print ─── */
  /*
   * A4 print layout optimisation (Sub-AC 22-2).
   *
   * Physical page: 210mm × 297mm
   * Usable content area (after @page margins of 20mm top/bottom, 18mm left/right):
   *   width  = 210 − 36 = 174mm
   *   height = 297 − 40 = 257mm  (≈ 36 lines at 11pt / 1.45 line-height)
   *
   * Strategy:
   *  1. Strip all screen chrome (shadows, glass panels, sticky header, suggestion panel).
   *  2. Apply A4-density type scale (pt-based font sizes, tighter line-height & gaps).
   *  3. Protect contact header and compact sections from mid-element page breaks.
   *  4. Protect individual items (experience/project/education/cert) from splitting.
   *  5. Keep section headings glued to their first item (page-break-after: avoid).
   *  6. Allow long sections (experience, projects) to span pages naturally.
   *  7. Orphan/widow control for summary paragraphs and bullet lists.
   */
  @media print {
    /* ── 1. Hide screen-only elements ── */
    .no-print { display: none !important; }

    /* Source provenance badges are screen metadata only */
    .rb-source-badge { display: none !important; }

    /* Source note (generated-at / source URL) is not needed on print */
    .rb-source-note { display: none !important; }

    /* Strength keywords section is informational-only, not printed */
    .rb-kw-section-wrap { display: none !important; }

    /* Strip 미반영 (unconfirmed) left-border visual treatment */
    .rb-item--unconfirmed {
      padding-left: 0 !important;
      border-left: none !important;
    }

    /* Hide all inline editing / interaction controls */
    .rb-add-bullet-trigger  { display: none !important; }
    .rb-add-bullet-form     { display: none !important; }
    .rb-bullet-actions      { display: none !important; }
    /* Reset editing/confirm-delete layout to normal row */
    .rb-bullet-item--editing,
    .rb-bullet-item--confirm-delete {
      flex-direction: row !important;
      align-items: flex-start !important;
    }

    /* ── 2. Strip card chrome ── */
    .rb-body {
      box-shadow: none;
      border: none;
      border-radius: 0;
      /* Remove all screen padding — @page margins supply the white space */
      padding: 0;
      backdrop-filter: none;
      background: #fff;
      /* A4 inter-section gap: 10pt ≈ 14px */
      gap: 10pt;
    }

    /* ── 3. A4 density type scale ── */
    /*
     * All sizes use pt (print points) to ensure consistent physical dimensions
     * independent of screen DPI / zoom level at print time.
     *
     * Reference scale for a two-page A4 resume:
     *   name          18pt  (prominent but not oversized)
     *   section-title 11pt bold
     *   body / bullet 10pt / 1.4
     *   sub / meta    9pt
     *   kicker/caps   7.5pt
     */

    /* Contact header — name */
    .rb-name {
      /* clamp() is unreliable in print; override with fixed pt */
      font-size: 18pt;
      margin-bottom: 3pt;
    }

    /* Contact row (email, phone, location …) */
    .rb-contact {
      font-size: 9pt;
      line-height: 1.4;
      gap: 2pt 8pt;
    }

    /* Divider between header and body */
    .rb-divider { margin: 4pt 0; }

    /* Section wrapper inter-element gap */
    .rb-section { gap: 6pt; }

    /* Section heading line */
    .rb-kicker        { font-size: 7.5pt; letter-spacing: 0.14em; }
    .rb-section-title { font-size: 11pt; }

    /* Summary paragraph */
    .rb-summary {
      font-size: 10pt;
      line-height: 1.5;
      /* Prevent orphaned single lines at top/bottom of page */
      orphans: 3;
      widows: 3;
    }

    /* Item list (experience / projects / education / certifications) */
    .rb-list { gap: 10pt; }

    /* Item titles & sub-text */
    .rb-item-title { font-size: 10.5pt; }
    .rb-item-sub   { font-size: 9pt; }

    /* Bullet list */
    .rb-bullets {
      font-size: 10pt;
      line-height: 1.4;
      gap: 1.5pt;
      padding-left: 14pt;
      /* Two-line minimum at top and bottom of page to avoid isolated bullets */
      orphans: 2;
      widows: 2;
    }

    /* Period / date string */
    .rb-period { font-size: 9pt; }

    /* Skills */
    .rb-skill-category { font-size: 8.5pt; }
    .rb-skill-tag {
      font-size: 9pt;
      padding: 1.5pt 6pt;
      /* Transparent background avoids ink waste; border preserves tag shape */
      background: transparent;
      border: 0.75pt solid rgba(17, 24, 39, 0.25);
    }
    .rb-skills-grouped { gap: 5pt; }
    .rb-skill-group    { gap: 3pt; }
    .rb-skill-tags     { gap: 3pt; }

    /* Education */
    .rb-edu-meta { font-size: 9pt; }

    /* ── 4. Page-break rules: item level ── */
    /*
     * Individual entries within multi-item sections.
     * Each entry (a job, a project, a degree, a cert) must not be split across
     * pages — both the property variants are included for broad browser support.
     */
    .rb-exp-item  { page-break-inside: avoid; break-inside: avoid; }
    .rb-proj-item { page-break-inside: avoid; break-inside: avoid; }
    .rb-edu-item  { page-break-inside: avoid; break-inside: avoid; }
    .rb-cert-item { page-break-inside: avoid; break-inside: avoid; }

    /*
     * Contact header block: keep name + contact row on the same page.
     * page-break-before: avoid — header always appears at document start,
     *   never pushed to a new page.
     * page-break-inside: avoid — do not split header mid-element.
     * page-break-after:  avoid — keep header glued to the first section below.
     */
    .rb-header {
      page-break-before: avoid;
      break-before: avoid;
      page-break-inside: avoid;
      break-inside: avoid;
      page-break-after: avoid;
      break-after: avoid;
    }

    /* ── 5. Page-break rules: section heading ── */
    /*
     * Keep the kicker + section title together with the first content item.
     * page-break-after: avoid means the browser will prefer inserting the page
     * break BEFORE the heading rather than between the heading and its content.
     */
    .rb-section-heading {
      page-break-after: avoid;
      break-after: avoid;
    }

    /* ── 6. Page-break rules: section level ── */
    /*
     * page-break-before for all named sections: auto (browser-controlled).
     *   - 'auto' allows natural page breaks before sections without forcing them.
     *   - 'always' is deliberately avoided — it would waste pages for short sections.
     *   - The heading's page-break-after:avoid already keeps headings glued to content.
     */
    .rb-section--summary,
    .rb-section--experience,
    .rb-section--projects,
    .rb-section--education,
    .rb-section--skills,
    .rb-section--certifications {
      page-break-before: auto;
      break-before: auto;
    }

    /*
     * Compact sections: keep entire section on one page when possible.
     *   summary        — typically 2–4 lines
     *   skills         — tag cloud, usually fits in one column block
     *   education      — 1–3 degree entries
     *   certifications — usually few items
     *
     * Long sections (experience, projects) are NOT listed here — they commonly
     * span multiple pages and must be allowed to flow naturally.
     * Their individual items (.rb-exp-item, .rb-proj-item) are still protected.
     */
    .rb-section--summary,
    .rb-section--skills,
    .rb-section--education,
    .rb-section--certifications {
      page-break-inside: avoid;
      break-inside: avoid;
    }

    /* ── 7. Bullet-item level: first bullet stays with item header ── */
    /*
     * Prevent the very first bullet from landing on a new page while the
     * company name / role line stays on the previous page.
     */
    .rb-bullets > li:first-child {
      page-break-before: avoid;
      break-before: avoid;
    }
  }
`;
