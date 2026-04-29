export function WorklogCard({ children, className = '', tone = 'default' }) {
  return <article class={`wl-card wl-card--${tone}${className ? ` ${className}` : ''}`}>{children}</article>;
}

export function WorklogSectionHeader({ kicker, title, subtitle = '', aside = null }) {
  return (
    <header class="wl-section-header">
      <div>
        {kicker ? <p class="wl-kicker">{kicker}</p> : null}
        <h3 class="wl-title">{title}</h3>
        {subtitle ? <p class="wl-subtitle">{subtitle}</p> : null}
      </div>
      {aside}
    </header>
  );
}

export function WorklogButton({ children, variant = 'primary', className = '', ...props }) {
  return (
    <button
      {...props}
      class={`wl-button wl-button--${variant}${className ? ` ${className}` : ''}`}
    >
      {children}
    </button>
  );
}

export function WorklogLinkButton({ children, variant = 'secondary', className = '', href, ...props }) {
  return (
    <a
      href={href}
      {...props}
      class={`wl-button wl-button--${variant}${className ? ` ${className}` : ''}`}
    >
      {children}
    </a>
  );
}

export function WorklogStatTile({ label, value, primary = false, text = false }) {
  return (
    <article class={`wl-stat-tile${primary ? ' wl-stat-tile--primary' : ''}${text ? ' wl-stat-tile--text' : ''}`}>
      <p class="wl-stat-label">{label}</p>
      <p class="wl-stat-value">{value}</p>
    </article>
  );
}

export function WorklogMetaLine({ label, value, compact = false }) {
  return (
    <div class={`wl-meta-line${compact ? ' wl-meta-line--compact' : ''}`}>
      <span class="wl-meta-label">{label}</span>
      <p>{value}</p>
    </div>
  );
}

export function WorklogMiniSection({ title, children, empty = '' }) {
  const hasContent = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <section class="wl-mini-section">
      <p class="wl-mini-title">{title}</p>
      {hasContent ? children : <p class="wl-mini-empty">{empty}</p>}
    </section>
  );
}

export const WORKLOG_PRIMITIVES_CSS = `
  .wl-card {
    display: grid;
    gap: 20px;
    min-width: 0;
    padding: 24px;
    border-radius: 24px;
    border: 1px solid rgba(15, 23, 42, 0.08);
    background: rgba(255, 255, 255, 0.94);
    box-shadow: 0 16px 32px rgba(15, 23, 42, 0.05);
  }

  .wl-card--primary {
    background: linear-gradient(135deg, rgba(245, 247, 255, 0.98), rgba(255, 255, 255, 0.94));
    border-color: rgba(53, 87, 214, 0.12);
    box-shadow: 0 24px 48px rgba(37, 99, 235, 0.08);
  }

  .wl-card--soft {
    background: rgba(255, 255, 255, 0.84);
    box-shadow: 0 12px 24px rgba(15, 23, 42, 0.04);
  }

  .wl-section-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }

  .wl-kicker {
    margin: 0 0 6px;
    font-size: 10px;
    letter-spacing: 0.16em;
    font-weight: 700;
    color: #64748b;
    text-transform: uppercase;
  }

  .wl-title {
    margin: 0;
    font-size: 24px;
    font-weight: 700;
    line-height: 1.26;
    letter-spacing: -0.03em;
    color: #0f172a;
  }

  .wl-subtitle {
    margin: 6px 0 0;
    max-width: none;
    font-size: 14px;
    line-height: 1.65;
    color: #667085;
    text-wrap: pretty;
  }

  .wl-section-header > div {
    min-width: 0;
    flex: 1 1 420px;
  }

  .wl-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    border-radius: 999px;
    border: 1px solid rgba(15, 23, 42, 0.12);
    min-height: 44px;
    padding: 10px 16px;
    font: inherit;
    font-size: 13px;
    font-weight: 700;
    line-height: 1.2;
    white-space: nowrap;
    text-decoration: none;
    cursor: pointer;
    transition: transform 160ms ease, box-shadow 160ms ease, background-color 160ms ease;
  }

  .wl-button:hover {
    transform: translateY(-1px);
  }

  .wl-button:disabled,
  .wl-button[aria-disabled='true'] {
    opacity: 0.55;
    cursor: not-allowed;
    transform: none;
    box-shadow: none;
    filter: saturate(0.8);
  }

  .wl-button:disabled:hover,
  .wl-button[aria-disabled='true']:hover {
    transform: none;
  }

  .wl-button--primary {
    color: #fff;
    background: linear-gradient(135deg, #4462e6 0%, #2d4bc7 100%);
    box-shadow: 0 12px 24px rgba(61, 89, 224, 0.22);
  }

  .wl-button--secondary {
    color: #1f2a44;
    background: rgba(245, 248, 255, 0.96);
    border-color: rgba(86, 104, 214, 0.14);
  }

  .wl-button--quiet {
    color: #4c5d84;
    background: rgba(247, 249, 255, 0.76);
    border-color: rgba(86, 104, 214, 0.10);
  }

  .wl-stat-tile {
    display: grid;
    align-content: start;
    min-height: 100%;
    padding: 16px 18px;
    border-radius: 20px;
    border: 1px solid rgba(15, 23, 42, 0.08);
    background: rgba(255, 255, 255, 0.92);
    box-shadow: 0 10px 24px rgba(15, 23, 42, 0.04);
  }

  .wl-stat-tile--primary {
    border-left: 3px solid #4462e6;
    background: linear-gradient(180deg, rgba(250, 251, 255, 0.98), rgba(244, 247, 255, 0.98));
  }

  .wl-stat-label {
    margin: 0;
    color: #64748b;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .wl-stat-value {
    margin: 6px 0 0;
    color: #0f172a;
    font-size: clamp(24px, 2.4vw, 34px);
    line-height: 0.98;
    font-weight: 700;
    letter-spacing: -0.02em;
  }

  .wl-stat-tile--text .wl-stat-value {
    font-size: clamp(16px, 1.6vw, 20px);
    font-weight: 600;
    line-height: 1.15;
  }

  .wl-meta-line {
    display: grid;
    gap: 4px;
  }

  .wl-meta-line--compact {
    gap: 2px;
  }

  .wl-meta-label {
    display: inline-block;
    color: #667085;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .wl-meta-line p {
    margin: 0;
    color: #0f172a;
    font-size: 14px;
    line-height: 1.6;
  }

  .wl-mini-section {
    display: grid;
    gap: 10px;
    align-content: start;
  }

  .wl-mini-title {
    margin: 0;
    color: #667085;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .wl-mini-empty {
    margin: 0;
    color: #667085;
    font-size: 14px;
    line-height: 1.6;
  }
`;
