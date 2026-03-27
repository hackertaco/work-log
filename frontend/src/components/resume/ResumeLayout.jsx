/**
 * ResumeLayout
 *
 * 이력서 메인 화면의 2-column 레이아웃 컴포넌트.
 *
 * 좌측 (body)  : 이력서 본문 뷰 — 섹션별 내용을 편집·표시
 * 우측 (panel) : 제안 패널 — 갱신 후보 승인/편집/반영 UI
 *
 * Props:
 *   body  — 좌측에 렌더링할 노드 (이력서 본문)
 *   panel — 우측에 렌더링할 노드 (제안 패널)
 *
 * 레이아웃 규칙:
 *   - 기본: 1fr / 300px 2열 그리드, align-items: start
 *   - ≤860px: 단일 컬럼, 패널이 위로 올라옴 (order: -1)
 *   - @media print: 단일 컬럼, 패널 숨김
 */
export function ResumeLayout({ body, panel }) {
  return (
    <div class="rl-root">
      {/* 좌측: 이력서 본문 */}
      <div class="rl-body">
        {body}
      </div>

      {/* 우측: 제안 패널 */}
      <aside class="rl-panel" aria-label="갱신 제안 패널">
        {panel}
      </aside>

      <style>{LAYOUT_CSS}</style>
    </div>
  );
}

/* ──────────────────────────────────────────────────────── */
/* Styles                                                   */
/* ──────────────────────────────────────────────────────── */

const LAYOUT_CSS = `
  /* ─── 2-column grid ─── */
  .rl-root {
    display: grid;
    grid-template-columns: 1fr 300px;
    grid-template-areas: "body panel";
    gap: var(--space-6);
    align-items: start;
  }

  .rl-body {
    grid-area: body;
    min-width: 0; /* prevent grid blowout on long content */
  }

  .rl-panel {
    grid-area: panel;
    position: sticky;
    top: calc(56px + var(--space-4)); /* clear the sticky header (≈56px) */
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-width: 0;
  }

  /* ─── Responsive: collapse to single column ─── */
  @media (max-width: 860px) {
    .rl-root {
      grid-template-columns: 1fr;
      grid-template-areas:
        "panel"
        "body";
    }

    .rl-panel {
      position: static; /* no sticky on mobile */
      order: -1;
    }
  }

  /* ─── Print: hide panel, full-width body ─── */
  @media print {
    .rl-root {
      display: block;
    }

    .rl-panel {
      display: none !important;
    }

    .rl-body {
      width: 100%;
    }
  }
`;
