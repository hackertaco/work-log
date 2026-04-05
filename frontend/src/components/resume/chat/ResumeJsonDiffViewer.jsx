import { useState, useMemo } from 'preact/hooks';
import { computeResumeJsonDiff, countTotalChanges } from '../../../lib/resumeJsonDiff.js';

/**
 * ResumeJsonDiffViewer — 이력서 JSON 전체 diff 시각화 컴포넌트
 *
 * 원본 이력서 JSON과 수정된 이력서 JSON을 비교해 섹션·필드 단위로
 * 변경 전/후를 사람이 읽기 쉬운 형태로 표시한다.
 *
 * ResumeDiffViewer가 단일 섹션의 텍스트 diff를 담당한다면,
 * ResumeJsonDiffViewer는 이력서 전체 JSON 문서 간의 구조적 diff를 담당한다.
 *
 * Props:
 *   original  — object          원본 이력서 JSON
 *   modified  — object          수정된 이력서 JSON
 *   evidence  — string[]        변경 근거 목록 (optional)
 *   onApprove — () => void      전체 승인 콜백
 *   onReject  — () => void      전체 거절 콜백
 *   status    — 'pending' | 'approved' | 'rejected'  (기본값: 'pending')
 *   title     — string          헤더 제목 (optional)
 */
export function ResumeJsonDiffViewer({
  original,
  modified,
  evidence = [],
  onApprove,
  onReject,
  status = 'pending',
  title = '이력서 전체 변경 사항',
}) {
  // useMemo를 useState보다 먼저 선언해 초기 확장 상태에 활용한다.
  const sectionDiffs = useMemo(
    () => computeResumeJsonDiff(original, modified),
    [original, modified]
  );
  const totalChanges = useMemo(() => countTotalChanges(sectionDiffs), [sectionDiffs]);

  const [showEvidence, setShowEvidence] = useState(false);
  // 기본값: 변경 섹션이 5개 이하일 때 모두 펼쳐서 즉시 내용을 볼 수 있게 한다.
  const [expandedSections, setExpandedSections] = useState(
    () => new Set(sectionDiffs.length <= 5 ? sectionDiffs.map((d) => d.key) : [])
  );

  const isPending = status === 'pending';
  const isApproved = status === 'approved';
  const isRejected = status === 'rejected';

  function toggleSection(key) {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  const allExpanded = sectionDiffs.every((d) => expandedSections.has(d.key));

  function toggleAll() {
    if (allExpanded) {
      setExpandedSections(new Set());
    } else {
      setExpandedSections(new Set(sectionDiffs.map((d) => d.key)));
    }
  }

  // 변경 없음
  if (sectionDiffs.length === 0) {
    return (
      <div class="rjdv-root rjdv-root--empty" aria-label="이력서 변경 없음">
        <div class="rjdv-header">
          <span class="rjdv-header-icon" aria-hidden="true">≡</span>
          <span class="rjdv-header-title">{title}</span>
        </div>
        <p class="rjdv-no-change">변경 사항이 없습니다.</p>
        <style>{RJDV_CSS}</style>
      </div>
    );
  }

  return (
    <div
      class={`rjdv-root rjdv-root--${status}`}
      aria-label={`${title} (${totalChanges}건 변경)`}
    >
      {/* ── 헤더 ── */}
      <div class="rjdv-header">
        <span class="rjdv-header-icon" aria-hidden="true">
          {isApproved ? '✓' : isRejected ? '✕' : '↕'}
        </span>
        <span class="rjdv-header-title">{title}</span>
        <span class="rjdv-change-count" aria-label={`${totalChanges}건 변경`}>
          {totalChanges}건 변경
        </span>

        {/* 상태 배지 */}
        {!isPending && (
          <span
            class={`rjdv-status-badge rjdv-status-badge--${status}`}
            aria-label={isApproved ? '승인됨' : '거절됨'}
          >
            {isApproved ? '승인됨' : '거절됨'}
          </span>
        )}

        {/* 전체 펼치기/접기 — 섹션이 2개 이상일 때만 표시 */}
        {sectionDiffs.length >= 2 && (
          <button
            class="rjdv-expand-all-btn"
            type="button"
            onClick={toggleAll}
            aria-label={allExpanded ? '모든 섹션 접기' : '모든 섹션 펼치기'}
            title={allExpanded ? '모든 섹션 접기' : '모든 섹션 펼치기'}
          >
            {allExpanded ? '접기' : '모두 펼치기'}
          </button>
        )}
      </div>

      {/* ── 섹션 목록 ── */}
      <div class="rjdv-sections" role="list">
        {sectionDiffs.map((diff) => (
          <SectionDiffBlock
            key={diff.key}
            diff={diff}
            expanded={expandedSections.has(diff.key)}
            onToggle={() => toggleSection(diff.key)}
          />
        ))}
      </div>

      {/* ── 근거 섹션 ── */}
      {evidence.length > 0 && (
        <div class="rjdv-evidence-wrap">
          <button
            class="rjdv-evidence-toggle"
            type="button"
            onClick={() => setShowEvidence(!showEvidence)}
            aria-expanded={showEvidence}
          >
            {showEvidence ? '근거 숨기기' : `근거 보기 (${evidence.length}건)`}
            <span class="rjdv-toggle-arrow" aria-hidden="true">
              {showEvidence ? '▲' : '▼'}
            </span>
          </button>
          {showEvidence && (
            <ul class="rjdv-evidence-list" aria-label="변경 근거 목록">
              {evidence.map((ev, i) => (
                <li key={i} class="rjdv-evidence-item">
                  <span class="rjdv-evidence-dot" aria-hidden="true" />
                  <span>{ev}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ── Approve / Reject 버튼 ── */}
      {isPending && (
        <div class="rjdv-actions" role="group" aria-label="변경 사항 적용 결정">
          <button
            class="rjdv-btn rjdv-btn--approve"
            type="button"
            onClick={onApprove}
            aria-label="모든 변경 사항 승인"
            title="이력서에 모든 변경 사항을 반영합니다"
          >
            <span class="rjdv-btn-icon" aria-hidden="true">✓</span>
            모두 승인
          </button>
          <button
            class="rjdv-btn rjdv-btn--reject"
            type="button"
            onClick={onReject}
            aria-label="변경 사항 거절"
            title="변경 사항을 반영하지 않습니다"
          >
            <span class="rjdv-btn-icon" aria-hidden="true">✕</span>
            거절
          </button>
        </div>
      )}

      <style>{RJDV_CSS}</style>
    </div>
  );
}

/* ── 섹션 diff 블록 ──────────────────────────────────────────────────────────── */

/**
 * 개별 섹션의 변경 내용을 펼치기/접기로 표시하는 블록.
 */
function SectionDiffBlock({ diff, expanded, onToggle }) {
  const changeCount = _sectionChangeCount(diff);

  return (
    <div class="rjdv-section" role="listitem">
      {/* 섹션 헤더 (펼치기/접기 토글) */}
      <button
        class="rjdv-section-header"
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`${diff.label} 섹션 (${changeCount}건 변경) ${expanded ? '접기' : '펼치기'}`}
      >
        <span class="rjdv-section-icon" aria-hidden="true">
          {expanded ? '▼' : '▶'}
        </span>
        <span class="rjdv-section-label">{diff.label}</span>
        <span class="rjdv-section-count" aria-hidden="true">
          {changeCount}건
        </span>
      </button>

      {/* 섹션 내용 (펼침 상태에만 표시) */}
      {expanded && (
        <div class="rjdv-section-body">
          {diff.type === 'scalar' && <ScalarSectionDiff diff={diff} />}
          {diff.type === 'text' && <TextSectionDiff diff={diff} />}
          {diff.type === 'array' && <ArraySectionDiff diff={diff} />}
          {diff.type === 'skills' && <SkillsSectionDiff diff={diff} />}
          {diff.type === 'tags' && <TagsSectionDiff diff={diff} />}
        </div>
      )}
    </div>
  );
}

/* ── 섹션 타입별 렌더러 ──────────────────────────────────────────────────────── */

/** 연락처 등 스칼라 필드 집합 diff */
function ScalarSectionDiff({ diff }) {
  return (
    <table class="rjdv-field-table" aria-label="필드 변경 목록">
      <thead>
        <tr>
          <th class="rjdv-th rjdv-th--field">항목</th>
          <th class="rjdv-th rjdv-th--before">이전</th>
          <th class="rjdv-th rjdv-th--after">이후</th>
        </tr>
      </thead>
      <tbody>
        {diff.fields.map((fc) => (
          <tr key={fc.field} class={`rjdv-tr rjdv-tr--${fc.type}`}>
            <td class="rjdv-td rjdv-td--field">{fc.label}</td>
            <td class="rjdv-td rjdv-td--before">
              {fc.type === 'added' ? (
                <span class="rjdv-empty-cell">—</span>
              ) : (
                <span class="rjdv-before-val">{fc.before}</span>
              )}
            </td>
            <td class="rjdv-td rjdv-td--after">
              {fc.type === 'deleted' ? (
                <span class="rjdv-empty-cell">—</span>
              ) : (
                <span class="rjdv-after-val">{fc.after}</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 자기소개 텍스트 diff — Myers LCS 줄 단위 */
function TextSectionDiff({ diff }) {
  const hunks = _computeLineDiff(diff.before, diff.after);

  return (
    <div class="rjdv-text-diff" role="region" aria-label="텍스트 변경 내용">
      {hunks.map((hunk, i) => {
        const prefix = hunk.type === 'add' ? '+' : hunk.type === 'remove' ? '−' : ' ';
        return (
          <div
            key={i}
            class={`rjdv-text-line rjdv-text-line--${hunk.type}`}
            aria-label={
              hunk.type === 'add'
                ? '추가된 내용'
                : hunk.type === 'remove'
                ? '삭제된 내용'
                : undefined
            }
          >
            <span class="rjdv-text-prefix" aria-hidden="true">{prefix}</span>
            <span class="rjdv-text-content">{hunk.text || '\u00a0'}</span>
          </div>
        );
      })}
    </div>
  );
}

/** 배열 섹션 diff (경력·학력·프로젝트·자격증) */
function ArraySectionDiff({ diff }) {
  return (
    <div class="rjdv-array-diff">
      {/* 추가된 항목 */}
      {diff.added.map((item, i) => (
        <ArrayItemBlock
          key={`added-${i}`}
          kind="added"
          label={_itemDisplayLabel(item)}
          item={item}
        />
      ))}

      {/* 수정된 항목 */}
      {diff.modified.map((mod) => (
        <ArrayItemModified key={`mod-${mod.key}`} mod={mod} />
      ))}

      {/* 삭제된 항목 */}
      {diff.deleted.map((item, i) => (
        <ArrayItemBlock
          key={`deleted-${i}`}
          kind="deleted"
          label={_itemDisplayLabel(item)}
          item={item}
        />
      ))}
    </div>
  );
}

/** 추가/삭제된 배열 항목 카드 */
function ArrayItemBlock({ kind, label, item }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div class={`rjdv-item-block rjdv-item-block--${kind}`}>
      <button
        class="rjdv-item-header"
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-label={`${kind === 'added' ? '추가된' : '삭제된'} 항목: ${label}`}
      >
        <span class="rjdv-item-kind-badge" aria-hidden="true">
          {kind === 'added' ? '추가' : '삭제'}
        </span>
        <span class="rjdv-item-label">{label}</span>
        <span class="rjdv-item-toggle" aria-hidden="true">
          {expanded ? '▲' : '▼'}
        </span>
      </button>

      {expanded && (
        <div class="rjdv-item-detail">
          <ItemFields item={item} />
        </div>
      )}
    </div>
  );
}

/** 수정된 배열 항목 — 변경된 필드만 표시 */
function ArrayItemModified({ mod }) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div class="rjdv-item-block rjdv-item-block--modified">
      <button
        class="rjdv-item-header"
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        aria-label={`수정된 항목: ${mod.label}${mod.userOwned ? ' (사용자 수정 항목)' : ''}`}
      >
        <span class="rjdv-item-kind-badge" aria-hidden="true">
          수정
        </span>
        <span class="rjdv-item-label">
          {mod.label}
          {mod.userOwned && (
            <span class="rjdv-user-owned-badge" title="사용자가 직접 수정한 항목">
              ✏ 사용자 수정
            </span>
          )}
        </span>
        <span class="rjdv-item-change-count" aria-hidden="true">
          {mod.fieldChanges.length}개 필드
        </span>
        <span class="rjdv-item-toggle" aria-hidden="true">
          {expanded ? '▲' : '▼'}
        </span>
      </button>

      {expanded && (
        <div class="rjdv-item-detail">
          {mod.fieldChanges.map((fc) => (
            <FieldChangeRow key={fc.field} fc={fc} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 수정된 필드 한 행 */
function FieldChangeRow({ fc }) {
  if (fc.type === 'array') {
    return (
      <div class="rjdv-field-row rjdv-field-row--array">
        <span class="rjdv-field-name">{fc.label}</span>
        <div class="rjdv-bullet-diff">
          {fc.added.map((b, i) => (
            <div key={`a${i}`} class="rjdv-bullet rjdv-bullet--added">
              <span class="rjdv-bullet-prefix" aria-hidden="true">+</span>
              <span>{b}</span>
            </div>
          ))}
          {fc.deleted.map((b, i) => (
            <div key={`d${i}`} class="rjdv-bullet rjdv-bullet--deleted">
              <span class="rjdv-bullet-prefix" aria-hidden="true">−</span>
              <span>{b}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div class={`rjdv-field-row rjdv-field-row--${fc.type}`}>
      <span class="rjdv-field-name">{fc.label}</span>
      <div class="rjdv-field-values">
        {fc.type !== 'added' && fc.before !== null && (
          <span class="rjdv-before-val" aria-label={`이전: ${fc.before}`}>
            {fc.before}
          </span>
        )}
        {fc.type === 'modified' && (
          <span class="rjdv-arrow" aria-hidden="true">→</span>
        )}
        {fc.type !== 'deleted' && fc.after !== null && (
          <span class="rjdv-after-val" aria-label={`이후: ${fc.after}`}>
            {fc.after}
          </span>
        )}
        {fc.type === 'added' && (
          <span class="rjdv-after-val">{fc.after}</span>
        )}
        {fc.type === 'deleted' && (
          <span class="rjdv-before-val rjdv-before-val--strikethrough">
            {fc.before}
          </span>
        )}
      </div>
    </div>
  );
}

/** 항목의 모든 필드를 표시 (추가/삭제 항목 상세 뷰) */
function ItemFields({ item }) {
  const displayFields = Object.entries(item).filter(
    ([k, v]) =>
      !k.startsWith('_') &&
      v !== null &&
      v !== undefined &&
      v !== '' &&
      !(Array.isArray(v) && v.length === 0)
  );

  return (
    <dl class="rjdv-item-fields">
      {displayFields.map(([k, v]) => (
        <div key={k} class="rjdv-item-field-pair">
          <dt class="rjdv-item-field-key">{_fieldLabel(k)}</dt>
          <dd class="rjdv-item-field-val">
            {Array.isArray(v)
              ? v.map((line, i) => (
                  <div key={i} class="rjdv-item-field-bullet">
                    • {line}
                  </div>
                ))
              : String(v)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** 기술 섹션 diff */
function SkillsSectionDiff({ diff }) {
  const categories = ['technical', 'languages', 'tools'].filter(
    (cat) => diff[cat].added.length > 0 || diff[cat].deleted.length > 0
  );

  return (
    <div class="rjdv-skills-diff">
      {categories.map((cat) => (
        <div key={cat} class="rjdv-skills-category">
          <span class="rjdv-skills-cat-label">{diff[cat].label}</span>
          <div class="rjdv-tag-list">
            {diff[cat].added.map((kw, i) => (
              <span key={`a${i}`} class="rjdv-tag rjdv-tag--added" aria-label={`추가: ${kw}`}>
                +{kw}
              </span>
            ))}
            {diff[cat].deleted.map((kw, i) => (
              <span key={`d${i}`} class="rjdv-tag rjdv-tag--deleted" aria-label={`삭제: ${kw}`}>
                −{kw}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** 키워드 태그 diff (강점 키워드) */
function TagsSectionDiff({ diff }) {
  return (
    <div class="rjdv-tag-list rjdv-tag-list--standalone">
      {diff.added.map((kw, i) => (
        <span key={`a${i}`} class="rjdv-tag rjdv-tag--added" aria-label={`추가: ${kw}`}>
          +{kw}
        </span>
      ))}
      {diff.deleted.map((kw, i) => (
        <span key={`d${i}`} class="rjdv-tag rjdv-tag--deleted" aria-label={`삭제: ${kw}`}>
          −{kw}
        </span>
      ))}
    </div>
  );
}

/* ── 내부 유틸리티 ───────────────────────────────────────────────────────────── */

/**
 * 섹션 diff의 변경 건수를 반환한다.
 * @param {import('../../../lib/resumeJsonDiff.js').SectionDiff} diff
 * @returns {number}
 */
function _sectionChangeCount(diff) {
  if (diff.type === 'scalar') return diff.fields.length;
  if (diff.type === 'text') return 1;
  if (diff.type === 'array') return diff.added.length + diff.deleted.length + diff.modified.length;
  if (diff.type === 'skills') {
    let n = 0;
    for (const cat of ['technical', 'languages', 'tools']) {
      n += (diff[cat]?.added?.length ?? 0) + (diff[cat]?.deleted?.length ?? 0);
    }
    return n;
  }
  if (diff.type === 'tags') return diff.added.length + diff.deleted.length;
  return 0;
}

/** 항목을 식별하기 위한 표시 레이블 반환 */
function _itemDisplayLabel(item) {
  if (!item) return '';
  if (item.company || item.title) {
    return [item.company, item.title].filter(Boolean).join(' — ');
  }
  if (item.institution) {
    return [item.institution, item.degree].filter(Boolean).join(' ');
  }
  return item.name ?? '';
}

/** 알려진 필드 키에 대한 한국어 레이블 반환 */
const ALL_FIELD_LABELS = {
  name: '이름 / 프로젝트명 / 자격증명',
  email: '이메일',
  phone: '전화번호',
  location: '위치 / 근무지',
  website: '웹사이트',
  linkedin: 'LinkedIn',
  company: '회사명',
  title: '직함',
  start_date: '시작일',
  end_date: '종료일',
  degree: '학위',
  field: '전공',
  institution: '학교명',
  gpa: 'GPA',
  description: '설명',
  url: 'URL',
  issuer: '발급 기관',
  date: '날짜',
  expiry_date: '만료일',
  bullets: '주요 내용',
  tech_stack: '기술 스택',
};

function _fieldLabel(key) {
  return ALL_FIELD_LABELS[key] ?? key;
}

/* ── Myers LCS 줄 단위 diff ─────────────────────────────────────────────────── */

function _computeLineDiff(oldText, newText) {
  const oldLines = (oldText || '').split('\n');
  const newLines = (newText || '').split('\n');
  const lcs = _buildLCS(oldLines, newLines);
  const hunks = [];
  let oi = 0;
  let ni = 0;

  for (const [oldIdx, newIdx] of lcs) {
    while (oi < oldIdx) {
      hunks.push({ type: 'remove', text: oldLines[oi] });
      oi++;
    }
    while (ni < newIdx) {
      hunks.push({ type: 'add', text: newLines[ni] });
      ni++;
    }
    hunks.push({ type: 'equal', text: oldLines[oldIdx] });
    oi = oldIdx + 1;
    ni = newIdx + 1;
  }

  while (oi < oldLines.length) {
    hunks.push({ type: 'remove', text: oldLines[oi] });
    oi++;
  }
  while (ni < newLines.length) {
    hunks.push({ type: 'add', text: newLines[ni] });
    ni++;
  }

  return hunks;
}

function _buildLCS(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const result = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  result.reverse();
  return result;
}

/* ── Styles ─────────────────────────────────────────────────────────────────── */

const RJDV_CSS = `
  /* ─── Root ─── */
  .rjdv-root {
    border-radius: var(--radius-md);
    border: 1px solid var(--line-strong);
    background: rgba(255, 255, 255, 0.97);
    overflow: hidden;
    font-size: 13px;
    margin: var(--space-2) 0;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
  }

  .rjdv-root--empty {
    opacity: 0.7;
  }

  .rjdv-root--approved {
    border-color: #86efac;
    background: rgba(240, 253, 244, 0.95);
  }

  .rjdv-root--rejected {
    border-color: #fca5a5;
    background: rgba(254, 242, 242, 0.95);
    opacity: 0.75;
  }

  /* ─── 헤더 ─── */
  .rjdv-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: rgba(248, 246, 242, 0.9);
    border-bottom: 1px solid var(--line);
    flex-wrap: wrap;
  }

  .rjdv-root--approved .rjdv-header {
    background: rgba(220, 252, 231, 0.8);
    border-color: #86efac;
  }

  .rjdv-root--rejected .rjdv-header {
    background: rgba(254, 226, 226, 0.8);
    border-color: #fca5a5;
  }

  .rjdv-header-icon {
    font-size: 14px;
    font-weight: 700;
    color: var(--muted);
    flex-shrink: 0;
  }

  .rjdv-root--approved .rjdv-header-icon { color: #16a34a; }
  .rjdv-root--rejected .rjdv-header-icon { color: #dc2626; }

  .rjdv-header-title {
    flex: 1;
    font-weight: 700;
    font-size: 12px;
    color: var(--ink-strong);
    letter-spacing: -0.01em;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .rjdv-change-count {
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
    white-space: nowrap;
  }

  .rjdv-status-badge {
    font-size: 10px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 999px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    flex-shrink: 0;
  }

  .rjdv-status-badge--approved {
    background: rgba(22, 163, 74, 0.12);
    color: #16a34a;
    border: 1px solid rgba(22, 163, 74, 0.3);
  }

  .rjdv-status-badge--rejected {
    background: rgba(220, 38, 38, 0.1);
    color: #dc2626;
    border: 1px solid rgba(220, 38, 38, 0.25);
  }

  /* ─── 전체 펼치기/접기 버튼 ─── */
  .rjdv-expand-all-btn {
    flex-shrink: 0;
    background: none;
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-sm);
    padding: 2px 8px;
    font-size: 10px;
    font-weight: 600;
    color: var(--muted);
    cursor: pointer;
    letter-spacing: 0.02em;
    transition: background 0.12s, border-color 0.12s, color 0.12s;
    white-space: nowrap;
    line-height: 1.6;
  }

  .rjdv-expand-all-btn:hover {
    background: rgba(30, 64, 175, 0.06);
    border-color: var(--accent);
    color: var(--accent);
  }

  /* ─── 섹션 목록 ─── */
  .rjdv-sections {
    display: flex;
    flex-direction: column;
  }

  /* ─── 섹션 블록 ─── */
  .rjdv-section {
    border-bottom: 1px solid var(--line);
  }

  .rjdv-section:last-child {
    border-bottom: none;
  }

  .rjdv-section-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-2) var(--space-3);
    background: none;
    border: none;
    text-align: left;
    cursor: pointer;
    transition: background 0.12s;
    font-size: 12px;
  }

  .rjdv-section-header:hover {
    background: rgba(0, 0, 0, 0.025);
  }

  .rjdv-section-icon {
    font-size: 9px;
    color: var(--muted);
    flex-shrink: 0;
    width: 12px;
    text-align: center;
  }

  .rjdv-section-label {
    flex: 1;
    font-weight: 700;
    color: var(--ink-strong);
    letter-spacing: -0.01em;
  }

  .rjdv-section-count {
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
    background: rgba(0, 0, 0, 0.05);
    padding: 1px 7px;
    border-radius: 999px;
    flex-shrink: 0;
  }

  .rjdv-section-body {
    padding: 0 var(--space-3) var(--space-3);
    animation: rjdv-expand 0.15s ease;
  }

  @keyframes rjdv-expand {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* ─── 변경 없음 ─── */
  .rjdv-no-change {
    padding: var(--space-3);
    color: var(--muted);
    font-style: italic;
    margin: 0;
    text-align: center;
    font-size: 12px;
  }

  /* ─── 스칼라 필드 테이블 (연락처) ─── */
  .rjdv-field-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    margin-top: var(--space-1);
  }

  .rjdv-th {
    padding: 4px var(--space-2);
    text-align: left;
    font-size: 10px;
    font-weight: 700;
    color: var(--muted);
    letter-spacing: 0.05em;
    text-transform: uppercase;
    border-bottom: 1px solid var(--line);
    white-space: nowrap;
  }

  .rjdv-th--field { width: 100px; }
  .rjdv-th--before, .rjdv-th--after { width: 50%; }

  .rjdv-tr--added {
    background: rgba(22, 163, 74, 0.05);
  }

  .rjdv-tr--deleted {
    background: rgba(220, 38, 38, 0.05);
  }

  .rjdv-tr--modified {
    background: rgba(234, 179, 8, 0.04);
  }

  .rjdv-td {
    padding: 5px var(--space-2);
    vertical-align: top;
    border-bottom: 1px solid var(--line);
  }

  .rjdv-td--field {
    font-weight: 600;
    color: var(--muted);
    font-size: 11px;
    white-space: nowrap;
  }

  .rjdv-empty-cell {
    color: var(--line-strong);
  }

  /* ─── 텍스트 diff (자기소개) ─── */
  .rjdv-text-diff {
    font-family: "SF Mono", "Menlo", "Consolas", monospace;
    font-size: 12px;
    line-height: 1.6;
    max-height: 280px;
    overflow-y: auto;
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    margin-top: var(--space-1);
    overflow-x: auto;
  }

  .rjdv-text-line {
    display: flex;
    align-items: flex-start;
    padding: 1px var(--space-2);
    min-height: 20px;
    word-break: break-word;
    white-space: pre-wrap;
  }

  .rjdv-text-line--equal { color: var(--ink); background: transparent; }

  .rjdv-text-line--add {
    background: rgba(22, 163, 74, 0.08);
    color: #166534;
    border-left: 3px solid #16a34a;
  }

  .rjdv-text-line--remove {
    background: rgba(220, 38, 38, 0.07);
    color: #991b1b;
    border-left: 3px solid #dc2626;
    text-decoration: line-through;
    opacity: 0.85;
  }

  .rjdv-text-prefix {
    flex-shrink: 0;
    width: 16px;
    font-weight: 700;
    opacity: 0.6;
    user-select: none;
  }

  .rjdv-text-line--add .rjdv-text-prefix { color: #16a34a; opacity: 1; }
  .rjdv-text-line--remove .rjdv-text-prefix { color: #dc2626; opacity: 1; }

  .rjdv-text-content { flex: 1; min-width: 0; }

  /* ─── 배열 섹션 ─── */
  .rjdv-array-diff {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin-top: var(--space-1);
  }

  /* ─── 항목 블록 ─── */
  .rjdv-item-block {
    border-radius: var(--radius-sm);
    border: 1px solid transparent;
    overflow: hidden;
  }

  .rjdv-item-block--added {
    border-color: rgba(22, 163, 74, 0.25);
    background: rgba(22, 163, 74, 0.03);
  }

  .rjdv-item-block--deleted {
    border-color: rgba(220, 38, 38, 0.2);
    background: rgba(220, 38, 38, 0.03);
    opacity: 0.85;
  }

  .rjdv-item-block--modified {
    border-color: rgba(234, 179, 8, 0.3);
    background: rgba(254, 252, 232, 0.5);
  }

  .rjdv-item-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    padding: 5px var(--space-2);
    background: none;
    border: none;
    text-align: left;
    cursor: pointer;
    font-size: 12px;
    transition: background 0.12s;
  }

  .rjdv-item-header:hover { background: rgba(0, 0, 0, 0.03); }

  .rjdv-item-kind-badge {
    font-size: 10px;
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 4px;
    flex-shrink: 0;
    letter-spacing: 0.02em;
  }

  .rjdv-item-block--added .rjdv-item-kind-badge {
    background: rgba(22, 163, 74, 0.15);
    color: #166534;
  }

  .rjdv-item-block--deleted .rjdv-item-kind-badge {
    background: rgba(220, 38, 38, 0.12);
    color: #991b1b;
  }

  .rjdv-item-block--modified .rjdv-item-kind-badge {
    background: rgba(234, 179, 8, 0.2);
    color: #92400e;
  }

  .rjdv-item-label {
    flex: 1;
    font-weight: 600;
    color: var(--ink-strong);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .rjdv-user-owned-badge {
    font-size: 10px;
    font-weight: 600;
    color: var(--accent);
    background: rgba(30, 64, 175, 0.08);
    padding: 1px 6px;
    border-radius: 4px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .rjdv-item-change-count {
    font-size: 10px;
    color: var(--muted);
    white-space: nowrap;
    flex-shrink: 0;
  }

  .rjdv-item-toggle {
    font-size: 9px;
    color: var(--muted);
    flex-shrink: 0;
  }

  .rjdv-item-detail {
    padding: 0 var(--space-2) var(--space-2);
    border-top: 1px solid rgba(0, 0, 0, 0.06);
  }

  /* ─── 필드 변경 행 ─── */
  .rjdv-field-row {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    padding: 4px 0;
    border-bottom: 1px solid var(--line);
    font-size: 12px;
  }

  .rjdv-field-row:last-child { border-bottom: none; }

  .rjdv-field-name {
    flex-shrink: 0;
    width: 80px;
    font-weight: 600;
    color: var(--muted);
    font-size: 11px;
    padding-top: 1px;
  }

  .rjdv-field-values {
    flex: 1;
    display: flex;
    align-items: center;
    gap: var(--space-1);
    flex-wrap: wrap;
    min-width: 0;
  }

  .rjdv-before-val {
    color: #991b1b;
    background: rgba(220, 38, 38, 0.07);
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 12px;
    text-decoration: line-through;
    opacity: 0.85;
  }

  .rjdv-before-val--strikethrough {
    text-decoration: line-through;
  }

  .rjdv-after-val {
    color: #166534;
    background: rgba(22, 163, 74, 0.08);
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 12px;
  }

  .rjdv-arrow {
    color: var(--muted);
    font-size: 11px;
    flex-shrink: 0;
  }

  /* ─── 불릿 diff ─── */
  .rjdv-field-row--array {
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
  }

  .rjdv-bullet-diff {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-left: var(--space-2);
  }

  .rjdv-bullet {
    display: flex;
    align-items: flex-start;
    gap: var(--space-1);
    font-size: 12px;
    padding: 1px 0;
  }

  .rjdv-bullet--added { color: #166534; }
  .rjdv-bullet--deleted { color: #991b1b; text-decoration: line-through; opacity: 0.85; }

  .rjdv-bullet-prefix {
    flex-shrink: 0;
    font-weight: 700;
    width: 12px;
    font-family: "SF Mono", monospace;
  }

  /* ─── 항목 필드 상세 (추가/삭제 항목 펼침) ─── */
  .rjdv-item-fields {
    margin: 0;
    padding: var(--space-1) 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .rjdv-item-field-pair {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    font-size: 12px;
  }

  .rjdv-item-field-key {
    flex-shrink: 0;
    width: 80px;
    font-weight: 600;
    color: var(--muted);
    font-size: 11px;
    padding-top: 1px;
  }

  .rjdv-item-field-val {
    flex: 1;
    min-width: 0;
    color: var(--ink);
    margin: 0;
  }

  .rjdv-item-field-bullet {
    margin-bottom: 2px;
    line-height: 1.5;
  }

  /* ─── 기술 섹션 ─── */
  .rjdv-skills-diff {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-top: var(--space-1);
  }

  .rjdv-skills-category {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
  }

  .rjdv-skills-cat-label {
    flex-shrink: 0;
    width: 96px;
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
    padding-top: 3px;
  }

  /* ─── 태그 목록 (기술·강점 키워드) ─── */
  .rjdv-tag-list {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    flex: 1;
  }

  .rjdv-tag-list--standalone {
    margin-top: var(--space-1);
  }

  .rjdv-tag {
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 999px;
  }

  .rjdv-tag--added {
    background: rgba(22, 163, 74, 0.12);
    color: #166534;
    border: 1px solid rgba(22, 163, 74, 0.25);
  }

  .rjdv-tag--deleted {
    background: rgba(220, 38, 38, 0.08);
    color: #991b1b;
    border: 1px solid rgba(220, 38, 38, 0.2);
    text-decoration: line-through;
    opacity: 0.85;
  }

  /* ─── 근거 ─── */
  .rjdv-evidence-wrap {
    border-top: 1px solid var(--line);
    padding: var(--space-2) var(--space-3);
  }

  .rjdv-evidence-toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    background: none;
    border: none;
    padding: 0;
    font-size: 11px;
    color: var(--accent);
    cursor: pointer;
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 2px;
    transition: opacity 0.12s;
  }

  .rjdv-evidence-toggle:hover { opacity: 0.75; }

  .rjdv-toggle-arrow {
    font-size: 9px;
    text-decoration: none;
  }

  .rjdv-evidence-list {
    margin: var(--space-2) 0 0;
    padding: var(--space-2) var(--space-3);
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 5px;
    background: rgba(248, 246, 240, 0.8);
    border-radius: var(--radius-sm);
    border: 1px solid var(--line);
  }

  .rjdv-evidence-item {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    font-size: 11px;
    color: var(--muted);
    line-height: 1.55;
  }

  .rjdv-evidence-dot {
    flex-shrink: 0;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent);
    margin-top: 4px;
  }

  /* ─── Actions ─── */
  .rjdv-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-top: 1px solid var(--line);
    background: rgba(248, 248, 250, 0.8);
    justify-content: flex-end;
  }

  .rjdv-btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: 6px 14px;
    border-radius: var(--radius-sm);
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.02em;
    border: 1.5px solid transparent;
    cursor: pointer;
    transition: background 0.13s, border-color 0.13s, transform 0.1s;
    user-select: none;
  }

  .rjdv-btn:active { transform: scale(0.97); }

  .rjdv-btn-icon {
    font-size: 12px;
    font-weight: 900;
    line-height: 1;
  }

  .rjdv-btn--approve {
    background: rgba(22, 163, 74, 0.1);
    border-color: rgba(22, 163, 74, 0.4);
    color: #166534;
  }

  .rjdv-btn--approve:hover {
    background: #16a34a;
    border-color: #16a34a;
    color: #fff;
    box-shadow: 0 2px 8px rgba(22, 163, 74, 0.3);
  }

  .rjdv-btn--reject {
    background: rgba(100, 100, 100, 0.06);
    border-color: rgba(100, 100, 100, 0.2);
    color: var(--muted);
  }

  .rjdv-btn--reject:hover {
    background: rgba(220, 38, 38, 0.08);
    border-color: rgba(220, 38, 38, 0.3);
    color: #dc2626;
  }

  /* ─── 반응형 ─── */
  @media (max-width: 480px) {
    .rjdv-actions {
      justify-content: stretch;
    }
    .rjdv-btn {
      flex: 1;
      justify-content: center;
    }
    .rjdv-field-name,
    .rjdv-item-field-key,
    .rjdv-skills-cat-label {
      width: 64px;
    }
    .rjdv-th--field { width: 72px; }
  }

  /* ─── 인쇄 ─── */
  @media print {
    .rjdv-root { display: none !important; }
  }
`;
