import { useState } from 'preact/hooks';
import {
  computeResumeJsonDiff,
  countTotalChanges,
} from '../../lib/resumeJsonDiff.js';

/**
 * ResumeJsonDiffViewer — 두 이력서 JSON 객체 간의 변경 내용을 시각화하는 컴포넌트
 *
 * 원본 이력서 JSON과 수정된 이력서 JSON을 비교해 섹션 단위로 변경 전/후를
 * 사람이 읽기 쉬운 형식으로 표시한다.
 *
 * 변경 유형:
 *   • scalar  — 연락처 같은 스칼라 필드 변경
 *   • text    — 자기소개 등 텍스트 섹션 변경 (줄 단위 diff)
 *   • array   — 경력·학력·프로젝트·자격증 항목 추가/수정/삭제
 *   • skills  — 기술 스택 카테고리별 추가/삭제
 *   • tags    — 강점 키워드 추가/삭제
 *
 * Props:
 *   beforeJson   — object            원본 이력서 JSON
 *   afterJson    — object            수정된 이력서 JSON
 *   title        — string            헤더 제목 (기본값: '이력서 변경 내용')
 *   emptyMessage — string            변경 없을 때 메시지
 *   collapsible  — boolean           섹션 접기 기능 활성화 (기본: true)
 *   className    — string            루트 요소 추가 클래스
 */
export function ResumeJsonDiffViewer({
  beforeJson,
  afterJson,
  title = '이력서 변경 내용',
  emptyMessage = '변경된 내용이 없습니다.',
  collapsible = true,
  className = '',
}) {
  const diffs = computeResumeJsonDiff(beforeJson, afterJson);
  const totalChanges = countTotalChanges(diffs);

  if (diffs.length === 0) {
    return (
      <div class={`rjdv-root rjdv-empty ${className}`} aria-label="이력서 변경 없음">
        <span class="rjdv-empty-icon" aria-hidden="true">✓</span>
        <span class="rjdv-empty-msg">{emptyMessage}</span>
        <style>{RJDV_CSS}</style>
      </div>
    );
  }

  return (
    <div class={`rjdv-root ${className}`} aria-label="이력서 변경 내용 비교">
      {/* ── 헤더 ── */}
      <div class="rjdv-header" role="banner">
        <span class="rjdv-header-icon" aria-hidden="true">⇄</span>
        <h2 class="rjdv-header-title">{title}</h2>
        <span class="rjdv-change-count" aria-label={`총 ${totalChanges}건 변경`}>
          {totalChanges}건 변경
        </span>
      </div>

      {/* ── 섹션별 diff ── */}
      <div class="rjdv-sections">
        {diffs.map((diff) => (
          <SectionDiffBlock
            key={diff.key}
            diff={diff}
            collapsible={collapsible}
          />
        ))}
      </div>

      <style>{RJDV_CSS}</style>
    </div>
  );
}

/* ── 섹션 diff 블록 ──────────────────────────────────────────────────────────── */

/**
 * @param {{ diff: import('../../lib/resumeJsonDiff.js').SectionDiff, collapsible: boolean }} props
 */
function SectionDiffBlock({ diff, collapsible }) {
  const [collapsed, setCollapsed] = useState(false);

  const { key, label, type } = diff;

  // 변경 타입에 따른 뱃지 텍스트와 스타일
  const badgeInfo = _getSectionBadge(diff);

  return (
    <div class={`rjdv-section rjdv-section--${type}`} aria-label={`${label} 섹션 변경`}>
      {/* 섹션 헤더 */}
      <div class="rjdv-section-header">
        <span class="rjdv-section-icon" aria-hidden="true">
          {type === 'text' ? '¶' : type === 'array' ? '[]' : type === 'skills' ? '⌥' : type === 'tags' ? '#' : '·'}
        </span>
        <h3 class="rjdv-section-label">{label}</h3>
        <span
          class={`rjdv-section-badge rjdv-section-badge--${badgeInfo.style}`}
          aria-label={badgeInfo.text}
        >
          {badgeInfo.text}
        </span>

        {collapsible && (
          <button
            class="rjdv-collapse-btn"
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? `${label} 펼치기` : `${label} 접기`}
          >
            <svg
              class={`rjdv-collapse-icon${collapsed ? ' rjdv-collapse-icon--up' : ''}`}
              viewBox="0 0 16 16"
              fill="currentColor"
              width="12"
              height="12"
              aria-hidden="true"
            >
              <path d="M4.293 5.293a1 1 0 011.414 0L8 7.586l2.293-2.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z" />
            </svg>
          </button>
        )}
      </div>

      {/* 변경 내용 본문 */}
      {!collapsed && (
        <div class="rjdv-section-body">
          {type === 'text' && <TextDiffBody diff={diff} />}
          {type === 'scalar' && <ScalarDiffBody diff={diff} />}
          {type === 'array' && <ArrayDiffBody diff={diff} />}
          {type === 'skills' && <SkillsDiffBody diff={diff} />}
          {type === 'tags' && <TagsDiffBody diff={diff} />}
        </div>
      )}
    </div>
  );
}

/* ── 텍스트 diff (자기소개 등) ──────────────────────────────────────────────── */

function TextDiffBody({ diff }) {
  const { before, after } = diff;
  const hunks = _computeLineDiff(before ?? '', after ?? '');

  return (
    <div class="rjdv-text-diff" role="region" aria-label="텍스트 변경 내용">
      {hunks.map((hunk, i) => (
        <TextDiffLine key={i} hunk={hunk} />
      ))}
      {hunks.length === 0 && (
        <p class="rjdv-no-change">(변경 없음)</p>
      )}
    </div>
  );
}

function TextDiffLine({ hunk }) {
  const { type, text } = hunk;
  const prefix = type === 'add' ? '+' : type === 'remove' ? '−' : ' ';

  return (
    <div
      class={`rjdv-diff-line rjdv-diff-line--${type}`}
      aria-label={type === 'add' ? '추가' : type === 'remove' ? '삭제' : undefined}
    >
      <span class="rjdv-diff-prefix" aria-hidden="true">{prefix}</span>
      <span class="rjdv-diff-text">{text || '\u00a0'}</span>
    </div>
  );
}

/* ── 스칼라 diff (연락처 등) ────────────────────────────────────────────────── */

function ScalarDiffBody({ diff }) {
  const { fields = [] } = diff;

  return (
    <div class="rjdv-scalar-diff">
      {fields.map((fc) => (
        <div key={fc.field} class={`rjdv-field-change rjdv-field-change--${fc.type}`}>
          <span class="rjdv-field-label">{fc.label}</span>
          <div class="rjdv-field-values">
            {fc.before !== null && (
              <span class="rjdv-field-before" aria-label="변경 전">
                <span class="rjdv-val-badge rjdv-val-badge--before" aria-hidden="true">전</span>
                {fc.before}
              </span>
            )}
            {fc.after !== null && (
              <span class="rjdv-field-after" aria-label="변경 후">
                <span class="rjdv-val-badge rjdv-val-badge--after" aria-hidden="true">후</span>
                {fc.after}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── 배열 diff (경력·학력·프로젝트·자격증) ──────────────────────────────────── */

function ArrayDiffBody({ diff }) {
  const { added = [], deleted = [], modified = [] } = diff;

  return (
    <div class="rjdv-array-diff">
      {/* 추가된 항목 */}
      {added.length > 0 && (
        <ArrayItemGroup title="추가된 항목" type="added" count={added.length}>
          {added.map((item, i) => (
            <ArrayItem key={i} item={item} type="added" />
          ))}
        </ArrayItemGroup>
      )}

      {/* 수정된 항목 */}
      {modified.length > 0 && (
        <ArrayItemGroup title="수정된 항목" type="modified" count={modified.length}>
          {modified.map((mod) => (
            <ModifiedArrayItem key={mod.key} mod={mod} />
          ))}
        </ArrayItemGroup>
      )}

      {/* 삭제된 항목 */}
      {deleted.length > 0 && (
        <ArrayItemGroup title="삭제된 항목" type="deleted" count={deleted.length}>
          {deleted.map((item, i) => (
            <ArrayItem key={i} item={item} type="deleted" />
          ))}
        </ArrayItemGroup>
      )}
    </div>
  );
}

function ArrayItemGroup({ title, type, count, children }) {
  return (
    <div class={`rjdv-item-group rjdv-item-group--${type}`}>
      <div class="rjdv-item-group-header">
        <span class="rjdv-item-group-dot" aria-hidden="true" />
        <span class="rjdv-item-group-title">{title}</span>
        <span class="rjdv-item-count">{count}건</span>
      </div>
      <div class="rjdv-item-list">{children}</div>
    </div>
  );
}

function ArrayItem({ item, type }) {
  const label = _getItemDisplayLabel(item);
  const bullets = Array.isArray(item.bullets) ? item.bullets : [];
  const extraFields = _getItemExtraFields(item);

  return (
    <div class={`rjdv-array-item rjdv-array-item--${type}`}>
      <p class="rjdv-item-label">{label || '(이름 없음)'}</p>
      {extraFields.length > 0 && (
        <p class="rjdv-item-meta">{extraFields.join(' · ')}</p>
      )}
      {bullets.length > 0 && (
        <ul class="rjdv-item-bullets">
          {bullets.map((b, i) => (
            <li key={i} class="rjdv-item-bullet">{b}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ModifiedArrayItem({ mod }) {
  const { label, fieldChanges = [] } = mod;

  return (
    <div class="rjdv-array-item rjdv-array-item--modified">
      <p class="rjdv-item-label">{label || '(이름 없음)'}</p>
      <div class="rjdv-field-changes">
        {fieldChanges.map((fc, i) => (
          <FieldChangeRow key={i} fc={fc} />
        ))}
      </div>
    </div>
  );
}

function FieldChangeRow({ fc }) {
  if (fc.type === 'array') {
    return (
      <div class="rjdv-field-change-row">
        <span class="rjdv-field-name">{fc.label}</span>
        <div class="rjdv-array-change">
          {(fc.added ?? []).map((item, i) => (
            <span key={`add-${i}`} class="rjdv-inline-tag rjdv-inline-tag--add">+ {item}</span>
          ))}
          {(fc.deleted ?? []).map((item, i) => (
            <span key={`del-${i}`} class="rjdv-inline-tag rjdv-inline-tag--del">− {item}</span>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div class="rjdv-field-change-row">
      <span class="rjdv-field-name">{fc.label}</span>
      <div class="rjdv-scalar-change">
        {fc.before !== null && (
          <span class="rjdv-scalar-before" aria-label="변경 전">{fc.before}</span>
        )}
        {fc.before !== null && fc.after !== null && (
          <span class="rjdv-arrow" aria-hidden="true">→</span>
        )}
        {fc.after !== null && (
          <span class="rjdv-scalar-after" aria-label="변경 후">{fc.after}</span>
        )}
      </div>
    </div>
  );
}

/* ── 기술 스택 diff ─────────────────────────────────────────────────────────── */

function SkillsDiffBody({ diff }) {
  const categories = ['technical', 'languages', 'tools'];

  return (
    <div class="rjdv-skills-diff">
      {categories.map((cat) => {
        const catDiff = diff[cat];
        if (!catDiff) return null;
        const { label, added = [], deleted = [] } = catDiff;
        if (added.length === 0 && deleted.length === 0) return null;

        return (
          <div key={cat} class="rjdv-skills-cat">
            <span class="rjdv-skills-cat-label">{label}</span>
            <div class="rjdv-skills-tags">
              {added.map((s, i) => (
                <span key={`add-${i}`} class="rjdv-skill-tag rjdv-skill-tag--add">+ {s}</span>
              ))}
              {deleted.map((s, i) => (
                <span key={`del-${i}`} class="rjdv-skill-tag rjdv-skill-tag--del">− {s}</span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── 태그 diff (강점 키워드 등) ─────────────────────────────────────────────── */

function TagsDiffBody({ diff }) {
  const { added = [], deleted = [] } = diff;

  return (
    <div class="rjdv-tags-diff">
      {added.map((tag, i) => (
        <span key={`add-${i}`} class="rjdv-tag rjdv-tag--add">+ {tag}</span>
      ))}
      {deleted.map((tag, i) => (
        <span key={`del-${i}`} class="rjdv-tag rjdv-tag--del">− {tag}</span>
      ))}
    </div>
  );
}

/* ── 내부 유틸 ───────────────────────────────────────────────────────────────── */

/**
 * 섹션 diff 요약 뱃지 정보를 반환한다.
 */
function _getSectionBadge(diff) {
  const { type, added, deleted, modified, fields, before, after } = diff;

  if (type === 'text') {
    if (!before && after) return { text: '신규 추가', style: 'add' };
    if (before && !after)  return { text: '삭제됨', style: 'del' };
    return { text: '수정됨', style: 'mod' };
  }

  if (type === 'scalar') {
    const addCount = fields?.filter((f) => f.type === 'added').length ?? 0;
    const delCount = fields?.filter((f) => f.type === 'deleted').length ?? 0;
    const modCount = fields?.filter((f) => f.type === 'modified').length ?? 0;
    const parts = [];
    if (addCount > 0) parts.push(`+${addCount}`);
    if (delCount > 0) parts.push(`-${delCount}`);
    if (modCount > 0) parts.push(`~${modCount}`);
    return { text: parts.join(' '), style: 'mod' };
  }

  if (type === 'array') {
    const parts = [];
    if ((added?.length ?? 0) > 0)    parts.push(`+${added.length}개`);
    if ((deleted?.length ?? 0) > 0)  parts.push(`-${deleted.length}개`);
    if ((modified?.length ?? 0) > 0) parts.push(`~${modified.length}개`);
    return { text: parts.join(' '), style: parts.length === 1 && parts[0].startsWith('+') ? 'add' : parts.length === 1 && parts[0].startsWith('-') ? 'del' : 'mod' };
  }

  if (type === 'skills') {
    let addCount = 0, delCount = 0;
    for (const cat of ['technical', 'languages', 'tools']) {
      addCount += diff[cat]?.added?.length ?? 0;
      delCount += diff[cat]?.deleted?.length ?? 0;
    }
    const parts = [];
    if (addCount > 0) parts.push(`+${addCount}`);
    if (delCount > 0) parts.push(`-${delCount}`);
    return { text: parts.join(' '), style: addCount > 0 && delCount === 0 ? 'add' : delCount > 0 && addCount === 0 ? 'del' : 'mod' };
  }

  if (type === 'tags') {
    const parts = [];
    if ((diff.added?.length ?? 0) > 0)   parts.push(`+${diff.added.length}`);
    if ((diff.deleted?.length ?? 0) > 0)  parts.push(`-${diff.deleted.length}`);
    return { text: parts.join(' '), style: (diff.added?.length ?? 0) > 0 && (diff.deleted?.length ?? 0) === 0 ? 'add' : 'mod' };
  }

  return { text: '변경됨', style: 'mod' };
}

/**
 * 배열 항목의 표시 레이블을 반환한다.
 */
function _getItemDisplayLabel(item) {
  if (!item) return '';
  if (item.company || item.title) {
    return [item.company, item.title].filter(Boolean).join(' — ');
  }
  if (item.institution) {
    return [item.institution, item.degree].filter(Boolean).join(' ');
  }
  if (item.name) return item.name;
  return '';
}

/**
 * 항목의 부가 정보 (기간, 위치 등)를 반환한다.
 */
function _getItemExtraFields(item) {
  const parts = [];
  if (item.start_date) {
    parts.push(`${item.start_date} ~ ${item.end_date || '현재'}`);
  }
  if (item.location) parts.push(item.location);
  if (item.issuer)   parts.push(item.issuer);
  if (item.date && !item.start_date) parts.push(item.date);
  return parts;
}

/**
 * 두 텍스트를 줄 단위 LCS diff로 변환한다.
 * ResumeDiffViewer 의 computeDiff 와 동일한 알고리즘.
 */
function _computeLineDiff(oldText, newText) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  const lcs = _buildLCS(oldLines, newLines);
  const hunks = [];

  let oldIdx = 0;
  let newIdx = 0;

  for (const [oi, ni] of lcs) {
    while (oldIdx < oi) {
      hunks.push({ type: 'remove', text: oldLines[oldIdx] });
      oldIdx++;
    }
    while (newIdx < ni) {
      hunks.push({ type: 'add', text: newLines[newIdx] });
      newIdx++;
    }
    hunks.push({ type: 'equal', text: oldLines[oi] });
    oldIdx = oi + 1;
    newIdx = ni + 1;
  }

  while (oldIdx < oldLines.length) {
    hunks.push({ type: 'remove', text: oldLines[oldIdx] });
    oldIdx++;
  }
  while (newIdx < newLines.length) {
    hunks.push({ type: 'add', text: newLines[newIdx] });
    newIdx++;
  }

  return hunks;
}

function _buildLCS(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
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
  /* ─── 루트 ─── */
  .rjdv-root {
    border-radius: var(--radius-md);
    border: 1px solid var(--line-strong);
    background: rgba(255, 255, 255, 0.97);
    overflow: hidden;
    font-size: 13px;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
  }

  /* ─── 빈 상태 ─── */
  .rjdv-empty {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-4) var(--space-5);
    font-size: 13px;
    color: var(--muted);
    background: rgba(240, 253, 244, 0.6);
    border-color: #86efac;
  }

  .rjdv-empty-icon {
    font-size: 14px;
    color: #16a34a;
    flex-shrink: 0;
  }

  /* ─── 헤더 ─── */
  .rjdv-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    background: rgba(248, 246, 242, 0.9);
    border-bottom: 1px solid var(--line);
  }

  .rjdv-header-icon {
    font-size: 13px;
    color: var(--muted);
    flex-shrink: 0;
    line-height: 1;
  }

  .rjdv-header-title {
    flex: 1;
    margin: 0;
    font-size: 12px;
    font-weight: 700;
    color: var(--ink-strong);
    letter-spacing: -0.01em;
  }

  .rjdv-change-count {
    font-size: 10px;
    font-weight: 700;
    color: #1e40af;
    background: rgba(30, 64, 175, 0.1);
    padding: 2px 8px;
    border-radius: 999px;
    letter-spacing: 0.02em;
    white-space: nowrap;
  }

  /* ─── 섹션 목록 ─── */
  .rjdv-sections {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  /* ─── 개별 섹션 블록 ─── */
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
    padding: var(--space-2) var(--space-4);
    background: rgba(250, 249, 247, 0.7);
    cursor: default;
    user-select: none;
  }

  .rjdv-section-icon {
    font-size: 11px;
    color: var(--muted);
    flex-shrink: 0;
    font-family: "SF Mono", "Menlo", monospace;
    opacity: 0.6;
    width: 14px;
    text-align: center;
  }

  .rjdv-section-label {
    flex: 1;
    margin: 0;
    font-size: 11px;
    font-weight: 700;
    color: var(--ink-strong);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  /* ─── 섹션 뱃지 ─── */
  .rjdv-section-badge {
    font-size: 10px;
    font-weight: 700;
    padding: 1px 7px;
    border-radius: 999px;
    letter-spacing: 0.04em;
    flex-shrink: 0;
  }

  .rjdv-section-badge--add {
    background: rgba(22, 163, 74, 0.12);
    color: #16a34a;
    border: 1px solid rgba(22, 163, 74, 0.3);
  }

  .rjdv-section-badge--del {
    background: rgba(220, 38, 38, 0.1);
    color: #dc2626;
    border: 1px solid rgba(220, 38, 38, 0.25);
  }

  .rjdv-section-badge--mod {
    background: rgba(217, 119, 6, 0.1);
    color: #d97706;
    border: 1px solid rgba(217, 119, 6, 0.25);
  }

  /* ─── 접기 버튼 ─── */
  .rjdv-collapse-btn {
    flex-shrink: 0;
    background: none;
    border: none;
    padding: 2px;
    cursor: pointer;
    color: var(--muted);
    border-radius: var(--radius-sm);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.12s, color 0.12s;
    line-height: 1;
  }

  .rjdv-collapse-btn:hover {
    background: var(--line);
    color: var(--ink);
  }

  .rjdv-collapse-icon {
    display: block;
    transition: transform 0.2s;
  }

  .rjdv-collapse-icon--up {
    transform: rotate(180deg);
  }

  /* ─── 섹션 본문 ─── */
  .rjdv-section-body {
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--line);
    background: rgba(255, 255, 255, 0.7);
  }

  /* ─── 텍스트 diff (자기소개 등) ─── */
  .rjdv-text-diff {
    font-family: "SF Mono", "Menlo", "Consolas", monospace;
    font-size: 12px;
    line-height: 1.6;
    overflow-x: auto;
    max-height: 280px;
    overflow-y: auto;
  }

  .rjdv-diff-line {
    display: flex;
    align-items: flex-start;
    min-height: 20px;
    word-break: break-word;
    white-space: pre-wrap;
    padding: 1px var(--space-1);
  }

  .rjdv-diff-line--equal {
    color: var(--ink);
  }

  .rjdv-diff-line--add {
    background: rgba(22, 163, 74, 0.08);
    color: #166534;
    border-left: 3px solid #16a34a;
  }

  .rjdv-diff-line--remove {
    background: rgba(220, 38, 38, 0.07);
    color: #991b1b;
    border-left: 3px solid #dc2626;
    text-decoration: line-through;
    opacity: 0.85;
  }

  .rjdv-diff-prefix {
    flex-shrink: 0;
    width: 16px;
    font-weight: 700;
    user-select: none;
    opacity: 0.7;
    padding-right: 4px;
    font-family: "SF Mono", monospace;
  }

  .rjdv-diff-line--equal .rjdv-diff-prefix { opacity: 0.25; }
  .rjdv-diff-line--add .rjdv-diff-prefix { color: #16a34a; opacity: 1; }
  .rjdv-diff-line--remove .rjdv-diff-prefix { color: #dc2626; opacity: 1; }

  .rjdv-diff-text {
    flex: 1;
    min-width: 0;
  }

  .rjdv-no-change {
    margin: 0;
    font-size: 11px;
    color: var(--muted);
    font-style: italic;
    padding: var(--space-1) 0;
  }

  /* ─── 스칼라 diff ─── */
  .rjdv-scalar-diff {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .rjdv-field-change {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    font-size: 12px;
  }

  .rjdv-field-label {
    font-weight: 600;
    color: var(--muted);
    min-width: 80px;
    flex-shrink: 0;
    padding-top: 1px;
  }

  .rjdv-field-values {
    display: flex;
    flex-direction: column;
    gap: 3px;
    flex: 1;
    min-width: 0;
  }

  .rjdv-field-before,
  .rjdv-field-after {
    display: flex;
    align-items: flex-start;
    gap: var(--space-1);
    line-height: 1.4;
  }

  .rjdv-field-before {
    color: #991b1b;
    text-decoration: line-through;
    opacity: 0.8;
  }

  .rjdv-field-after {
    color: #166534;
  }

  .rjdv-val-badge {
    flex-shrink: 0;
    font-size: 9px;
    font-weight: 700;
    padding: 1px 4px;
    border-radius: 3px;
    letter-spacing: 0.03em;
    margin-top: 1px;
  }

  .rjdv-val-badge--before {
    background: rgba(220, 38, 38, 0.1);
    color: #dc2626;
  }

  .rjdv-val-badge--after {
    background: rgba(22, 163, 74, 0.12);
    color: #16a34a;
  }

  /* ─── 배열 diff ─── */
  .rjdv-array-diff {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .rjdv-item-group {
    border-radius: var(--radius-sm);
    overflow: hidden;
    border: 1px solid var(--line);
  }

  .rjdv-item-group--added {
    border-color: rgba(22, 163, 74, 0.3);
    background: rgba(240, 253, 244, 0.6);
  }

  .rjdv-item-group--deleted {
    border-color: rgba(220, 38, 38, 0.25);
    background: rgba(254, 242, 242, 0.6);
    opacity: 0.85;
  }

  .rjdv-item-group--modified {
    border-color: rgba(217, 119, 6, 0.25);
    background: rgba(255, 251, 235, 0.5);
  }

  .rjdv-item-group-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 5px var(--space-3);
    border-bottom: 1px solid inherit;
    font-size: 11px;
    font-weight: 600;
  }

  .rjdv-item-group--added .rjdv-item-group-header {
    color: #166534;
    background: rgba(22, 163, 74, 0.08);
    border-bottom-color: rgba(22, 163, 74, 0.2);
  }

  .rjdv-item-group--deleted .rjdv-item-group-header {
    color: #991b1b;
    background: rgba(220, 38, 38, 0.07);
    border-bottom-color: rgba(220, 38, 38, 0.18);
  }

  .rjdv-item-group--modified .rjdv-item-group-header {
    color: #92400e;
    background: rgba(217, 119, 6, 0.07);
    border-bottom-color: rgba(217, 119, 6, 0.18);
  }

  .rjdv-item-group-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .rjdv-item-group--added .rjdv-item-group-dot    { background: #16a34a; }
  .rjdv-item-group--deleted .rjdv-item-group-dot  { background: #dc2626; }
  .rjdv-item-group--modified .rjdv-item-group-dot { background: #d97706; }

  .rjdv-item-group-title {
    flex: 1;
  }

  .rjdv-item-count {
    font-size: 10px;
    font-weight: 700;
    opacity: 0.75;
  }

  .rjdv-item-list {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .rjdv-array-item {
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid rgba(0, 0, 0, 0.05);
    font-size: 12px;
  }

  .rjdv-array-item:last-child {
    border-bottom: none;
  }

  .rjdv-item-label {
    margin: 0 0 2px;
    font-weight: 600;
    color: var(--ink-strong);
    line-height: 1.4;
  }

  .rjdv-item-meta {
    margin: 0 0 4px;
    font-size: 11px;
    color: var(--muted);
  }

  .rjdv-item-bullets {
    margin: 4px 0 0;
    padding-left: 14px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .rjdv-item-bullet {
    font-size: 11px;
    color: var(--ink);
    line-height: 1.5;
    opacity: 0.85;
  }

  /* ─── 필드 변경 행 ─── */
  .rjdv-field-changes {
    margin-top: var(--space-2);
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .rjdv-field-change-row {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    font-size: 11px;
  }

  .rjdv-field-name {
    font-weight: 600;
    color: var(--muted);
    min-width: 64px;
    flex-shrink: 0;
    padding-top: 1px;
  }

  .rjdv-scalar-change {
    display: flex;
    align-items: flex-start;
    gap: 5px;
    flex-wrap: wrap;
    flex: 1;
    min-width: 0;
  }

  .rjdv-scalar-before {
    color: #991b1b;
    text-decoration: line-through;
    opacity: 0.8;
    font-size: 11px;
  }

  .rjdv-scalar-after {
    color: #166534;
    font-size: 11px;
  }

  .rjdv-arrow {
    color: var(--muted);
    font-size: 11px;
    padding-top: 1px;
  }

  .rjdv-array-change {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    flex: 1;
    min-width: 0;
  }

  /* ─── 인라인 태그 ─── */
  .rjdv-inline-tag {
    display: inline-block;
    font-size: 10px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 3px;
    white-space: nowrap;
  }

  .rjdv-inline-tag--add {
    background: rgba(22, 163, 74, 0.12);
    color: #16a34a;
    border: 1px solid rgba(22, 163, 74, 0.25);
  }

  .rjdv-inline-tag--del {
    background: rgba(220, 38, 38, 0.08);
    color: #dc2626;
    border: 1px solid rgba(220, 38, 38, 0.2);
    text-decoration: line-through;
    opacity: 0.8;
  }

  /* ─── 기술 스택 diff ─── */
  .rjdv-skills-diff {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .rjdv-skills-cat {
    display: flex;
    align-items: flex-start;
    gap: var(--space-2);
    font-size: 11px;
  }

  .rjdv-skills-cat-label {
    font-weight: 600;
    color: var(--muted);
    min-width: 80px;
    flex-shrink: 0;
    padding-top: 2px;
  }

  .rjdv-skills-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    flex: 1;
    min-width: 0;
  }

  .rjdv-skill-tag {
    display: inline-block;
    font-size: 10px;
    font-weight: 600;
    padding: 2px 7px;
    border-radius: 999px;
    white-space: nowrap;
  }

  .rjdv-skill-tag--add {
    background: rgba(22, 163, 74, 0.1);
    color: #16a34a;
    border: 1px solid rgba(22, 163, 74, 0.3);
  }

  .rjdv-skill-tag--del {
    background: rgba(220, 38, 38, 0.07);
    color: #dc2626;
    border: 1px solid rgba(220, 38, 38, 0.2);
    text-decoration: line-through;
    opacity: 0.75;
  }

  /* ─── 태그 diff ─── */
  .rjdv-tags-diff {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }

  .rjdv-tag {
    display: inline-block;
    font-size: 11px;
    font-weight: 600;
    padding: 2px 8px;
    border-radius: 999px;
    white-space: nowrap;
  }

  .rjdv-tag--add {
    background: rgba(22, 163, 74, 0.1);
    color: #16a34a;
    border: 1px solid rgba(22, 163, 74, 0.3);
  }

  .rjdv-tag--del {
    background: rgba(220, 38, 38, 0.07);
    color: #dc2626;
    border: 1px solid rgba(220, 38, 38, 0.2);
    text-decoration: line-through;
    opacity: 0.75;
  }

  /* ─── 반응형 ─── */
  @media (max-width: 480px) {
    .rjdv-section-body {
      padding: var(--space-2) var(--space-3);
    }

    .rjdv-field-label,
    .rjdv-skills-cat-label,
    .rjdv-field-name {
      min-width: 60px;
    }
  }
`;
