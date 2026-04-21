/**
 * ResumeShell — resume surfaces shared page shell.
 *
 * Props:
 *   children      — page body
 *   pendingCount  — optional pending suggestion count badge
 *   activePage    — 'resume' | 'chat'
 */
export function ResumeShell({ children, pendingCount = 0, activePage = 'resume' }) {
  const pageLabel = {
    chat: 'RESUME CHAT',
  }[activePage] ?? 'LIVING RESUME';

  return (
    <div class="resume-shell">
      <header class="resume-header">
        <div class="resume-header-inner">
          <div class="resume-wordmark">
            <span class="resume-wordmark-label">WORK LOG</span>
            <span class="resume-wordmark-sep">·</span>
            <span class="resume-wordmark-page">{pageLabel}</span>
            {pendingCount > 0 && activePage === 'resume' && (
              <span
                class="resume-pending-badge"
                aria-label={`미처리 갱신 제안 ${pendingCount}건`}
                title={`갱신 제안 ${pendingCount}건 대기 중`}
              >
                {pendingCount}
              </span>
            )}
          </div>
          <nav class="resume-nav">
            <a href="/" class="resume-nav-link">업무 로그</a>
            <a
              href="/resume"
              class={`resume-nav-link${activePage === 'resume' ? ' resume-nav-link--active' : ''}`}
            >
              이력서 편집
            </a>
            <a
              href="/resume/chat"
              class={`resume-nav-link${activePage === 'chat' ? ' resume-nav-link--active' : ''}`}
            >
              이력서 채팅
            </a>
            <button class="resume-nav-print" onClick={() => window.print()}>
              인쇄 / PDF 저장
            </button>
          </nav>
        </div>
      </header>

      <main class="resume-main">{children}</main>

      <style>{SHELL_CSS}</style>
    </div>
  );
}

export const SHELL_CSS = `
  .resume-shell {
    min-height: 100vh;
    background:
      radial-gradient(circle at top left, rgba(184, 212, 255, 0.2), transparent 34%),
      linear-gradient(180deg, rgba(252, 252, 251, 0.96) 0%, rgba(246, 244, 238, 0.98) 100%);
  }

  .resume-header {
    position: sticky;
    top: 0;
    z-index: 30;
    backdrop-filter: blur(14px);
    background: rgba(248, 246, 240, 0.88);
    border-bottom: 1px solid var(--line-soft);
    box-shadow: 0 10px 30px rgba(15, 23, 42, 0.04);
  }

  .resume-header-inner {
    max-width: min(1480px, calc(100vw - 40px));
    margin: 0 auto;
    padding: 14px 0 15px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
  }

  .resume-wordmark {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
  }

  .resume-wordmark-label,
  .resume-wordmark-page {
    font-size: 12px;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--text-strong);
  }

  .resume-wordmark-sep {
    color: var(--muted);
  }

  .resume-pending-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 22px;
    height: 22px;
    padding: 0 7px;
    border-radius: 999px;
    background: var(--text-strong);
    color: var(--surface);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.03em;
  }

  .resume-nav {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .resume-nav-link,
  .resume-nav-print {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 9px 13px;
    border-radius: 999px;
    border: 1px solid rgba(148, 163, 184, 0.24);
    background: rgba(255, 255, 255, 0.72);
    color: var(--text-strong);
    font-size: 13px;
    font-weight: 600;
    text-decoration: none;
    box-shadow: 0 1px 0 rgba(255, 255, 255, 0.45);
    transition: background-color 160ms ease, border-color 160ms ease, box-shadow 160ms ease;
  }

  .resume-nav-link--active {
    background: rgba(24, 32, 52, 0.92);
    border-color: rgba(24, 32, 52, 0.92);
    color: var(--surface);
    box-shadow: 0 10px 24px rgba(15, 23, 42, 0.16);
  }

  .resume-nav-link:hover,
  .resume-nav-print:hover {
    background: rgba(255, 255, 255, 0.94);
    box-shadow: 0 8px 20px rgba(15, 23, 42, 0.06);
  }

  .resume-nav-link--active:hover {
    background: rgba(24, 32, 52, 0.92);
  }

  .resume-main {
    width: min(1480px, calc(100vw - 40px));
    margin: 0 auto;
    padding: 28px 0 56px;
  }

  @media (max-width: 900px) {
    .resume-header-inner {
      align-items: flex-start;
      flex-direction: column;
    }

    .resume-nav {
      width: 100%;
      justify-content: flex-start;
    }

    .resume-main {
      width: min(100vw - 24px, 1400px);
      padding-top: 20px;
    }
  }
`;
