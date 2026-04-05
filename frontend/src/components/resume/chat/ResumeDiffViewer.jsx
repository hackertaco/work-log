import { useState } from 'preact/hooks';
import { DiffAction } from './DiffAction.jsx';

/**
 * ResumeDiffViewer — 이력서 섹션 수정 diff 표시 + approve/reject 컴포넌트
 *
 * 어시스턴트가 이력서 섹션 수정을 제안할 때 채팅 메시지에 삽입된다.
 * 수정 전(before)과 수정 후(after)를 줄 단위로 비교해 추가/삭제/유지를
 * 색상으로 구분하고, 사용자가 approve 또는 reject 버튼으로 결정한다.
 *
 * 추가/삭제 라인 하이라이트:
 *   - 줄 단위 diff: 추가(+)는 녹색, 삭제(−)는 빨간색 + 취소선
 *   - 토큰 단위 인라인 diff: 인접한 remove/add 줄 쌍에서 변경된 단어를
 *     더 진한 배경색으로 강조 표시 (단어 수준 하이라이트)
 *   - 변경 요약: 헤더에 추가/삭제 줄 수 표시
 *
 * Props:
 *   section              — string          섹션 이름 (예: "경력", "기술", "자기소개")
 *   before               — string          기존 텍스트
 *   after                — string          제안된 수정 텍스트
 *   evidence             — string[]        수정 근거 목록 (optional)
 *   onApprove            — () => void      승인 버튼 클릭 콜백
 *   onReject             — () => void      거절 버튼 클릭 콜백
 *   status               — 'pending' | 'queued' | 'approved' | 'rejected'  (기본값: 'pending')
 *                          'queued': 큐에 추가되어 처리 대기 중인 상태
 *   queuePosition        — number | null   큐에서의 순서 (1-based). null이면 표시 안 함.
 *                          status='queued' 이고 isCurrentlyProcessing=false 일 때 사용.
 *   isCurrentlyProcessing — boolean        큐에서 현재 이 항목이 처리(PATCH 요청) 중인지 여부.
 *                          true이면 '반영 중…' 애니메이션, false이면 '대기 중…' 표시.
 *   showLineNumbers      — boolean         줄 번호 표시 여부 (기본값: false)
 */
export function ResumeDiffViewer({
  section = '이력서 섹션',
  before = '',
  after = '',
  evidence = [],
  onApprove,
  onReject,
  status = 'pending',
  queuePosition = null,
  isCurrentlyProcessing = false,
  showLineNumbers = false,
}) {
  const [showEvidence, setShowEvidence] = useState(false);

  const hunks = enrichHunksWithInlineDiff(computeDiff(before, after));
  const isPending = status === 'pending';
  const isQueued = status === 'queued';
  const isApproved = status === 'approved';
  const isRejected = status === 'rejected';

  /* ─── 변경 요약 계산 ─── */
  const addedCount = hunks.filter((h) => h.type === 'add').length;
  const removedCount = hunks.filter((h) => h.type === 'remove').length;

  /* approve/reject 핸들러 및 큐 상태는 DiffAction 컴포넌트에서 관리 */

  /* ─── 헤더 아이콘 ─── */
  function getHeaderIcon() {
    if (isApproved) return '✓';
    if (isRejected) return '✕';
    if (isQueued && isCurrentlyProcessing) return '↻';
    if (isQueued) return '⏳';
    return '±';
  }

  /* ─── 상태 배지 레이블 ─── */
  function getStatusBadgeLabel() {
    if (isApproved) return '승인됨';
    if (isRejected) return '거절됨';
    if (isQueued && isCurrentlyProcessing) return '반영 중';
    if (isQueued) return queuePosition != null ? `${queuePosition}번째 대기` : '반영 대기 중';
    return status;
  }

  /* ─── 루트 클래스 ─── */
  const rootClass = isQueued && isCurrentlyProcessing
    ? 'rdv-root rdv-root--processing'
    : `rdv-root rdv-root--${status}`;

  return (
    <div class={rootClass} aria-label={`${section} 수정 제안`}>
      {/* ── 헤더 ── */}
      <div class="rdv-header">
        <span
          class={[
            'rdv-header-icon',
            isQueued && isCurrentlyProcessing ? 'rdv-header-icon--spinning' : '',
          ].filter(Boolean).join(' ')}
          aria-hidden="true"
        >
          {getHeaderIcon()}
        </span>
        <span class="rdv-section-label">{section} 수정 제안</span>

        {/* 변경 요약 칩 — pending/queued 일 때만 표시 */}
        {(isPending || isQueued) && (addedCount > 0 || removedCount > 0) && (
          <span class="rdv-change-summary" aria-label={`${addedCount}줄 추가, ${removedCount}줄 삭제`}>
            {addedCount > 0 && (
              <span class="rdv-change-summary__add">+{addedCount}</span>
            )}
            {removedCount > 0 && (
              <span class="rdv-change-summary__remove">−{removedCount}</span>
            )}
          </span>
        )}

        {/* 결정 상태 배지 */}
        {!isPending && (
          <span
            class={[
              'rdv-status-badge',
              `rdv-status-badge--${isQueued && isCurrentlyProcessing ? 'processing' : status}`,
            ].join(' ')}
            aria-label={getStatusBadgeLabel()}
          >
            {getStatusBadgeLabel()}
          </span>
        )}
      </div>

      {/* ── Diff 본문 ── */}
      <div class="rdv-diff" role="region" aria-label="변경 내용">
        {hunks.length > 0
          ? <DiffBody hunks={hunks} showLineNumbers={showLineNumbers} />
          : <p class="rdv-no-change">(변경 사항 없음)</p>
        }
      </div>

      {/* ── 근거 섹션 ── */}
      {evidence.length > 0 && (
        <div class="rdv-evidence-wrap">
          <button
            class="rdv-evidence-toggle"
            type="button"
            onClick={() => setShowEvidence(!showEvidence)}
            aria-expanded={showEvidence}
          >
            {showEvidence
              ? '근거 숨기기'
              : `근거 보기 (${evidence.length}건)`}
            <span class="rdv-toggle-arrow" aria-hidden="true">
              {showEvidence ? '▲' : '▼'}
            </span>
          </button>
          {showEvidence && (
            <ul class="rdv-evidence-list" aria-label="수정 근거 목록">
              {evidence.map((ev, i) => (
                <li key={i} class="rdv-evidence-item">
                  <span class="rdv-evidence-dot" aria-hidden="true" />
                  <span>{ev}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* ── Approve / Reject / 큐 상태 — DiffAction 컴포넌트 위임 ── */}
      <DiffAction
        status={status}
        section={section}
        onApprove={onApprove}
        onReject={onReject}
        queuePosition={queuePosition}
        isCurrentlyProcessing={isCurrentlyProcessing}
      />

      <style>{RDV_CSS}</style>
    </div>
  );
}

/* ── Diff 본문 컴포넌트 ───────────────────────────────────────────────────────── */

/**
 * DiffBody — 전체 diff hunk 목록을 렌더링한다.
 *
 * 연속된 equal 줄이 CONTEXT_LINES(3줄)를 초과할 경우 중간 부분을 접어 표시한다.
 * 변경(add/remove) 줄 전후 CONTEXT_LINES 줄만 노출하고 나머지는 '…N줄 숨김' 토글로 감춘다.
 *
 * @param {{
 *   hunks: Array<{ type: 'add'|'remove'|'equal', text: string, inlineParts?: InlinePart[] }>,
 *   showLineNumbers?: boolean,
 * }} props
 */
function DiffBody({ hunks, showLineNumbers = false }) {
  const CONTEXT_LINES = 3;

  // 어느 equal 줄이 변경(add/remove) 근처에 있는지 판별
  const isVisible = hunks.map(() => false);

  // 변경 줄 앞뒤 CONTEXT_LINES 줄을 보이도록 마킹
  for (let i = 0; i < hunks.length; i++) {
    if (hunks[i].type !== 'equal') {
      for (let j = Math.max(0, i - CONTEXT_LINES); j <= Math.min(hunks.length - 1, i + CONTEXT_LINES); j++) {
        isVisible[j] = true;
      }
    }
  }

  // 모든 줄이 equal이면 (변경 없음 — 이미 hunks.length === 0 체크 이후) 그냥 보여줌
  if (hunks.every((h) => h.type === 'equal')) {
    // 줄 번호 계산: equal 줄은 old/new 번호가 같다
    let lineNum = 1;
    return (
      <>
        {hunks.map((hunk, i) => {
          const ln = lineNum++;
          return <DiffLine key={i} hunk={hunk} showLineNumbers={showLineNumbers} lineNumOld={ln} lineNumNew={ln} />;
        })}
      </>
    );
  }

  // 그룹화: 연속 숨김 구간을 하나의 "collapsed" 그룹으로 묶는다
  const groups = [];
  let i = 0;
  while (i < hunks.length) {
    if (isVisible[i]) {
      groups.push({ type: 'visible', hunk: hunks[i], idx: i });
      i++;
    } else {
      // 연속된 숨김 equal 줄 수집
      const start = i;
      while (i < hunks.length && !isVisible[i]) i++;
      groups.push({ type: 'collapsed', from: start, to: i - 1, count: i - start });
    }
  }

  // 줄 번호 계산: old/new 각각 별도 카운터
  let oldLineNum = 1;
  let newLineNum = 1;

  // 전체 hunks에서 각 hunk의 old/new 줄 번호를 미리 계산
  const lineNums = hunks.map((hunk) => {
    const lo = hunk.type !== 'add' ? oldLineNum : null;
    const ln = hunk.type !== 'remove' ? newLineNum : null;
    if (hunk.type !== 'add') oldLineNum++;
    if (hunk.type !== 'remove') newLineNum++;
    return { lo, ln };
  });

  return (
    <>
      {groups.map((g, gi) =>
        g.type === 'visible'
          ? <DiffLine
              key={gi}
              hunk={g.hunk}
              showLineNumbers={showLineNumbers}
              lineNumOld={lineNums[g.idx].lo}
              lineNumNew={lineNums[g.idx].ln}
            />
          : <CollapsedLines
              key={gi}
              count={g.count}
              hunks={hunks.slice(g.from, g.to + 1)}
              showLineNumbers={showLineNumbers}
              startLineNums={lineNums.slice(g.from, g.to + 1)}
            />
      )}
    </>
  );
}

/* ── 접힌 줄 (context collapse) ─────────────────────────────────────────────── */

/**
 * CollapsedLines — 접힌 equal 줄 그룹.
 * 클릭하면 펼쳐진다.
 *
 * @param {{
 *   count: number,
 *   hunks: Array<{ type: string, text: string }>,
 *   showLineNumbers?: boolean,
 *   startLineNums?: Array<{ lo: number|null, ln: number|null }>,
 * }} props
 */
function CollapsedLines({ count, hunks, showLineNumbers = false, startLineNums = [] }) {
  const [expanded, setExpanded] = useState(false);

  if (expanded) {
    return (
      <>
        {hunks.map((hunk, i) => (
          <DiffLine
            key={i}
            hunk={hunk}
            showLineNumbers={showLineNumbers}
            lineNumOld={startLineNums[i]?.lo ?? null}
            lineNumNew={startLineNums[i]?.ln ?? null}
          />
        ))}
      </>
    );
  }

  return (
    <button
      class="rdv-collapse-toggle"
      type="button"
      onClick={() => setExpanded(true)}
      aria-label={`변경 없는 ${count}줄 펼치기`}
    >
      <span class="rdv-collapse-icon" aria-hidden="true">⋯</span>
      <span>{count}줄 변경 없음 — 펼치기</span>
    </button>
  );
}

/* ── Diff 줄 컴포넌트 ─────────────────────────────────────────────────────────── */

/**
 * @typedef {{ type: 'equal'|'add'|'remove', text: string }} InlinePart
 */

/**
 * DiffLine — 단일 diff 줄을 렌더링한다.
 *
 * inlineParts가 있으면 토큰 단위 하이라이트를 적용한다.
 * showLineNumbers가 true이면 줄 번호를 표시한다.
 *
 * @param {{
 *   hunk: {
 *     type: 'add'|'remove'|'equal',
 *     text: string,
 *     inlineParts?: InlinePart[],
 *   },
 *   showLineNumbers?: boolean,
 *   lineNumOld?: number|null,
 *   lineNumNew?: number|null,
 * }} props
 */
function DiffLine({ hunk, showLineNumbers = false, lineNumOld = null, lineNumNew = null }) {
  const { type, text, inlineParts } = hunk;

  const prefix = type === 'add' ? '+' : type === 'remove' ? '−' : ' ';
  const cls = `rdv-line rdv-line--${type}`;
  const ariaLabel = type === 'add' ? '추가된 줄' : type === 'remove' ? '삭제된 줄' : undefined;

  return (
    <div class={cls} aria-label={ariaLabel}>
      {/* 줄 번호 컬럼 */}
      {showLineNumbers && (
        <span class="rdv-line-nums" aria-hidden="true">
          <span class="rdv-line-num rdv-line-num--old">
            {lineNumOld != null ? lineNumOld : ''}
          </span>
          <span class="rdv-line-num rdv-line-num--new">
            {lineNumNew != null ? lineNumNew : ''}
          </span>
        </span>
      )}
      <span class="rdv-line-prefix" aria-hidden="true">{prefix}</span>
      <span class="rdv-line-text">
        {inlineParts && inlineParts.length > 0
          ? inlineParts.map((part, i) => (
              part.type === 'equal'
                ? <span key={i}>{part.text}</span>
                : <mark key={i} class={`rdv-token rdv-token--${part.type}`}>{part.text}</mark>
            ))
          : (text || '\u00a0' /* 빈 줄 보존 */)}
      </span>
    </div>
  );
}

/* ── Myers diff (줄 단위 LCS) ────────────────────────────────────────────────── */

/**
 * 두 텍스트를 줄 단위로 비교해 diff hunk 배열을 반환한다.
 * 외부 의존성 없이 LCS 기반으로 구현한다.
 *
 * @param {string} oldText
 * @param {string} newText
 * @returns {Array<{ type: 'add'|'remove'|'equal', text: string }>}
 */
function computeDiff(oldText, newText) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  const lcs = buildLCS(oldLines, newLines);
  const hunks = [];

  let oldIdx = 0;
  let newIdx = 0;

  for (const [oi, ni] of lcs) {
    // oldIdx ~ oi 사이의 줄들은 삭제됨
    while (oldIdx < oi) {
      hunks.push({ type: 'remove', text: oldLines[oldIdx] });
      oldIdx++;
    }
    // newIdx ~ ni 사이의 줄들은 추가됨
    while (newIdx < ni) {
      hunks.push({ type: 'add', text: newLines[newIdx] });
      newIdx++;
    }
    // 공통 줄
    hunks.push({ type: 'equal', text: oldLines[oi] });
    oldIdx = oi + 1;
    newIdx = ni + 1;
  }

  // 남은 삭제/추가
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

/* ── 토큰 단위 인라인 diff ────────────────────────────────────────────────────── */

/**
 * 텍스트를 단어/공백 단위 토큰으로 분리한다.
 * 공백, 단어, 구두점을 별도 토큰으로 나눠 세밀한 diff가 가능하게 한다.
 *
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  // 한글, 영문, 숫자, 공백, 구두점 단위로 분리
  return text.split(/(\s+|[^\w가-힣]+)/u).filter((t) => t.length > 0);
}

/**
 * 두 줄 사이의 유사도를 [0, 1] 범위로 계산한다.
 * 공통 토큰 수 / 전체 고유 토큰 수 (Jaccard 유사도)
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function lineSimilarity(a, b) {
  if (a === b) return 1;
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  let intersection = 0;
  for (const t of ta) {
    if (tb.has(t)) intersection++;
  }
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * remove 줄과 add 줄 사이의 토큰 단위 diff를 계산한다.
 *
 * @param {string} removeText  삭제된 줄 텍스트
 * @param {string} addText     추가된 줄 텍스트
 * @returns {{
 *   removeParts: InlinePart[],
 *   addParts:    InlinePart[],
 * }}
 */
function computeWordDiff(removeText, addText) {
  const removeTokens = tokenize(removeText);
  const addTokens = tokenize(addText);

  const lcs = buildLCS(removeTokens, addTokens);

  const removeParts = [];
  const addParts = [];

  let ri = 0;
  let ai = 0;

  for (const [rIdx, aIdx] of lcs) {
    // remove 측: ri ~ rIdx 사이 = 삭제된 토큰
    while (ri < rIdx) {
      removeParts.push({ type: 'remove', text: removeTokens[ri] });
      ri++;
    }
    // add 측: ai ~ aIdx 사이 = 추가된 토큰
    while (ai < aIdx) {
      addParts.push({ type: 'add', text: addTokens[ai] });
      ai++;
    }
    // 공통 토큰
    removeParts.push({ type: 'equal', text: removeTokens[rIdx] });
    addParts.push({ type: 'equal', text: addTokens[aIdx] });
    ri = rIdx + 1;
    ai = aIdx + 1;
  }

  // 남은 삭제/추가 토큰
  while (ri < removeTokens.length) {
    removeParts.push({ type: 'remove', text: removeTokens[ri] });
    ri++;
  }
  while (ai < addTokens.length) {
    addParts.push({ type: 'add', text: addTokens[ai] });
    ai++;
  }

  return { removeParts, addParts };
}

/**
 * 줄 단위 hunk 배열에 토큰 단위 인라인 diff 정보를 보강한다.
 *
 * 알고리즘:
 *   1. 연속된 remove/add 그룹을 찾는다
 *   2. 각 그룹에서 remove 줄과 add 줄을 1:1로 매칭 (유사도 기반)
 *   3. 유사도가 임계값(INLINE_DIFF_THRESHOLD) 이상인 쌍에 인라인 diff 적용
 *
 * 인라인 diff가 적용된 hunk에는 `inlineParts` 속성이 추가된다.
 *
 * @param {Array<{ type: 'add'|'remove'|'equal', text: string }>} hunks
 * @returns {Array<{ type: 'add'|'remove'|'equal', text: string, inlineParts?: InlinePart[] }>}
 */
function enrichHunksWithInlineDiff(hunks) {
  /** 유사도가 이 값 이상인 remove/add 쌍에만 인라인 diff 적용 */
  const INLINE_DIFF_THRESHOLD = 0.35;

  const result = [...hunks];

  // 그룹 탐색: 연속된 remove 뒤에 바로 add가 오는 구간을 찾는다
  let i = 0;
  while (i < result.length) {
    if (result[i].type !== 'remove') {
      i++;
      continue;
    }

    // 연속된 remove 줄 수집
    const removeStart = i;
    while (i < result.length && result[i].type === 'remove') i++;
    const removeEnd = i; // exclusive

    // 바로 뒤에 add 줄이 있는지 확인
    if (i >= result.length || result[i].type !== 'add') continue;

    const addStart = i;
    while (i < result.length && result[i].type === 'add') i++;
    const addEnd = i; // exclusive

    const removeLines = result.slice(removeStart, removeEnd);
    const addLines = result.slice(addStart, addEnd);

    // 매칭할 쌍의 수는 min(removeLines.length, addLines.length)
    const pairCount = Math.min(removeLines.length, addLines.length);

    for (let p = 0; p < pairCount; p++) {
      const rHunk = removeLines[p];
      const aHunk = addLines[p];
      const sim = lineSimilarity(rHunk.text, aHunk.text);

      if (sim >= INLINE_DIFF_THRESHOLD) {
        const { removeParts, addParts } = computeWordDiff(rHunk.text, aHunk.text);

        // 모든 파트가 equal이면 인라인 diff 불필요 (이미 동일한 내용)
        const hasRealDiff =
          removeParts.some((p) => p.type !== 'equal') ||
          addParts.some((p) => p.type !== 'equal');

        if (hasRealDiff) {
          result[removeStart + p] = { ...rHunk, inlineParts: removeParts };
          result[addStart + p] = { ...aHunk, inlineParts: addParts };
        }
      }
    }
  }

  return result;
}

/**
 * 두 줄 배열의 LCS(최장 공통 부분 수열)를 반환한다.
 * 반환값은 [oldIdx, newIdx] 쌍의 배열.
 *
 * @param {string[]} a
 * @param {string[]} b
 * @returns {[number, number][]}
 */
function buildLCS(a, b) {
  const m = a.length;
  const n = b.length;

  // DP 테이블 (m+1) x (n+1)
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

  // 역추적
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

const RDV_CSS = `
  /* ─── Root ─── */
  .rdv-root {
    border-radius: var(--radius-md);
    border: 1px solid var(--line-strong);
    background: rgba(255, 255, 255, 0.97);
    overflow: hidden;
    font-size: 13px;
    margin: var(--space-2) 0;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.06);
    transition: box-shadow 0.15s, border-color 0.2s, background 0.2s, opacity 0.25s;
  }

  .rdv-root--approved {
    border-color: #86efac;
    background: rgba(240, 253, 244, 0.95);
  }

  .rdv-root--rejected {
    border-color: #fca5a5;
    background: rgba(254, 242, 242, 0.95);
    opacity: 0.7;
    animation: rdv-rejected-appear 0.25s ease forwards;
  }

  @keyframes rdv-rejected-appear {
    from { opacity: 1; transform: scale(1); }
    to   { opacity: 0.7; transform: scale(1); }
  }

  .rdv-root--queued {
    border-color: #fcd34d;
    background: rgba(255, 251, 235, 0.95);
  }

  /* 현재 처리 중 (queued + isCurrentlyProcessing) */
  .rdv-root--processing {
    border-color: #60a5fa;
    background: rgba(239, 246, 255, 0.97);
    box-shadow: 0 0 0 2px rgba(96, 165, 250, 0.18), 0 1px 4px rgba(0,0,0,0.06);
    animation: rdv-processing-pulse 2s ease-in-out infinite;
  }

  @keyframes rdv-processing-pulse {
    0%, 100% { box-shadow: 0 0 0 2px rgba(96, 165, 250, 0.18), 0 1px 4px rgba(0,0,0,0.06); }
    50%       { box-shadow: 0 0 0 4px rgba(96, 165, 250, 0.28), 0 1px 8px rgba(0,0,0,0.08); }
  }

  /* ─── 헤더 ─── */
  .rdv-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: rgba(248, 246, 242, 0.9);
    border-bottom: 1px solid var(--line);
  }

  .rdv-root--approved .rdv-header {
    background: rgba(220, 252, 231, 0.8);
    border-color: #86efac;
  }

  .rdv-root--rejected .rdv-header {
    background: rgba(254, 226, 226, 0.8);
    border-color: #fca5a5;
  }

  .rdv-root--queued .rdv-header {
    background: rgba(254, 243, 199, 0.8);
    border-color: #fcd34d;
  }

  .rdv-root--processing .rdv-header {
    background: rgba(219, 234, 254, 0.85);
    border-color: #93c5fd;
  }

  .rdv-header-icon {
    font-size: 13px;
    font-weight: 700;
    color: var(--muted);
    flex-shrink: 0;
    line-height: 1;
  }

  .rdv-root--approved .rdv-header-icon  { color: #16a34a; }
  .rdv-root--rejected .rdv-header-icon  { color: #dc2626; }
  .rdv-root--queued .rdv-header-icon    { color: #d97706; }
  .rdv-root--processing .rdv-header-icon { color: #2563eb; }

  /* 처리 중 아이콘 회전 */
  .rdv-header-icon--spinning {
    display: inline-block;
    animation: rdv-spin 0.9s linear infinite;
  }

  .rdv-section-label {
    flex: 1;
    font-weight: 700;
    font-size: 12px;
    color: var(--ink-strong);
    letter-spacing: -0.01em;
  }

  /* ─── 상태 배지 ─── */
  .rdv-status-badge {
    font-size: 10px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 999px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  .rdv-status-badge--approved {
    background: rgba(22, 163, 74, 0.12);
    color: #16a34a;
    border: 1px solid rgba(22, 163, 74, 0.3);
  }

  .rdv-status-badge--rejected {
    background: rgba(220, 38, 38, 0.1);
    color: #dc2626;
    border: 1px solid rgba(220, 38, 38, 0.25);
  }

  .rdv-status-badge--queued {
    background: rgba(217, 119, 6, 0.1);
    color: #d97706;
    border: 1px solid rgba(217, 119, 6, 0.3);
  }

  .rdv-status-badge--processing {
    background: rgba(37, 99, 235, 0.1);
    color: #2563eb;
    border: 1px solid rgba(37, 99, 235, 0.3);
    animation: rdv-badge-blink 1.4s ease-in-out infinite;
  }

  @keyframes rdv-badge-blink {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.6; }
  }

  /* 큐/액션 스타일은 DiffAction 컴포넌트에서 관리 */

  /* ─── Diff 본문 ─── */
  .rdv-diff {
    font-family: "SF Mono", "Menlo", "Consolas", "Liberation Mono", monospace;
    font-size: 12px;
    line-height: 1.6;
    overflow-x: auto;
    max-height: 320px;
    overflow-y: auto;
    padding: var(--space-2) 0;
  }

  .rdv-no-change {
    padding: var(--space-2) var(--space-3);
    color: var(--muted);
    font-style: italic;
    margin: 0;
  }

  /* ─── Diff 줄 ─── */
  .rdv-line {
    display: flex;
    align-items: flex-start;
    gap: 0;
    padding: 1px var(--space-3);
    min-height: 20px;
    word-break: break-word;
    white-space: pre-wrap;
  }

  .rdv-line--equal {
    color: var(--ink);
    background: transparent;
  }

  .rdv-line--add {
    background: rgba(22, 163, 74, 0.08);
    color: #166534;
    border-left: 3px solid #16a34a;
  }

  .rdv-line--remove {
    background: rgba(220, 38, 38, 0.07);
    color: #991b1b;
    border-left: 3px solid #dc2626;
    text-decoration: line-through;
    opacity: 0.85;
  }

  .rdv-line-prefix {
    flex-shrink: 0;
    width: 18px;
    font-weight: 700;
    user-select: none;
    opacity: 0.7;
    padding-right: 4px;
  }

  .rdv-line--equal .rdv-line-prefix  { opacity: 0.3; }
  .rdv-line--add .rdv-line-prefix    { color: #16a34a; opacity: 1; }
  .rdv-line--remove .rdv-line-prefix { color: #dc2626; opacity: 1; }

  .rdv-line-text {
    flex: 1;
    min-width: 0;
  }

  /* ─── Context collapse 토글 ─── */
  .rdv-collapse-toggle {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    padding: 3px var(--space-3);
    background: rgba(248, 248, 250, 0.7);
    border: none;
    border-top: 1px dashed var(--line);
    border-bottom: 1px dashed var(--line);
    font-size: 11px;
    font-family: "SF Mono", "Menlo", "Consolas", "Liberation Mono", monospace;
    color: var(--muted);
    cursor: pointer;
    text-align: left;
    transition: background 0.12s, color 0.12s;
    letter-spacing: 0.01em;
  }

  .rdv-collapse-toggle:hover {
    background: rgba(30, 64, 175, 0.05);
    color: var(--accent);
  }

  .rdv-collapse-icon {
    font-size: 14px;
    opacity: 0.6;
    line-height: 1;
  }

  /* ─── 근거 ─── */
  .rdv-evidence-wrap {
    border-top: 1px solid var(--line);
    padding: var(--space-2) var(--space-3);
  }

  .rdv-evidence-toggle {
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

  .rdv-evidence-toggle:hover { opacity: 0.75; }

  .rdv-toggle-arrow {
    font-size: 9px;
    text-decoration: none;
  }

  .rdv-evidence-list {
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

  .rdv-evidence-item {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    font-size: 11px;
    color: var(--muted);
    line-height: 1.55;
  }

  .rdv-evidence-dot {
    flex-shrink: 0;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent);
    margin-top: 4px;
  }

  /* ─── 변경 요약 칩 ─── */
  .rdv-change-summary {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.01em;
  }

  .rdv-change-summary__add {
    color: #16a34a;
    background: rgba(22, 163, 74, 0.1);
    border: 1px solid rgba(22, 163, 74, 0.25);
    border-radius: 999px;
    padding: 1px 6px;
  }

  .rdv-change-summary__remove {
    color: #dc2626;
    background: rgba(220, 38, 38, 0.08);
    border: 1px solid rgba(220, 38, 38, 0.2);
    border-radius: 999px;
    padding: 1px 6px;
  }

  /* ─── 줄 번호 ─── */
  .rdv-line-nums {
    display: inline-flex;
    flex-shrink: 0;
    user-select: none;
  }

  .rdv-line-num {
    display: inline-block;
    width: 32px;
    text-align: right;
    padding-right: 8px;
    font-size: 11px;
    opacity: 0.45;
    font-variant-numeric: tabular-nums;
  }

  .rdv-line--add .rdv-line-num   { opacity: 0.65; color: #16a34a; }
  .rdv-line--remove .rdv-line-num { opacity: 0.65; color: #dc2626; }

  /* ─── 토큰 단위 인라인 diff 하이라이트 ─── */
  .rdv-token {
    border-radius: 2px;
    padding: 0 1px;
  }

  /* 삭제된 토큰 — 더 진한 빨간 배경 */
  .rdv-line--remove .rdv-token--remove {
    background: rgba(220, 38, 38, 0.22);
    color: #7f1d1d;
    text-decoration: line-through;
  }

  /* 추가된 토큰 — 더 진한 녹색 배경 */
  .rdv-line--add .rdv-token--add {
    background: rgba(22, 163, 74, 0.22);
    color: #14532d;
  }

  /* 액션 버튼 스타일은 DiffAction 컴포넌트에서 관리 */
`;
