import { useEffect, useState } from 'preact/hooks';

/**
 * BulletQualityPanel — Bullet quality tracking dashboard
 *
 * Fetches the quality report from GET /api/resume/quality-report and displays:
 *   - Overall usability rate (% of bullets with ≤50% semantic modification)
 *   - Distribution across edit buckets (pristine / minor / moderate / rewritten)
 *   - Action breakdown (approved / edited / discarded)
 *   - Mean and median similarity scores
 *   - Configurable time window filter
 *
 * This panel is fully self-contained (no props required).
 */
export function BulletQualityPanel() {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [daysBack, setDaysBack] = useState(30);

  useEffect(() => {
    let cancelled = false;

    async function fetchReport() {
      setLoading(true);
      setError('');
      try {
        const params = new URLSearchParams();
        if (daysBack) params.set('days', String(daysBack));
        const res = await fetch(`/api/resume/quality-report?${params}`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!cancelled) {
          setReport(data.qualityReport ?? null);
        }
      } catch (err) {
        if (!cancelled) setError(err.message || 'Failed to load quality report');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchReport();
    return () => { cancelled = true; };
  }, [daysBack]);

  // ── Styles ──────────────────────────────────────────────────────────────────
  const panelStyle = {
    border: '1px solid #e2e8f0',
    borderRadius: '8px',
    padding: '16px',
    marginBottom: '16px',
    backgroundColor: '#fafbfc',
    fontSize: '14px',
  };

  const headerStyle = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '12px',
  };

  const titleStyle = {
    fontSize: '15px',
    fontWeight: 600,
    color: '#1a202c',
    margin: 0,
  };

  const selectStyle = {
    fontSize: '13px',
    padding: '4px 8px',
    borderRadius: '4px',
    border: '1px solid #cbd5e0',
    background: '#fff',
  };

  const statGridStyle = {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
    gap: '10px',
    marginBottom: '12px',
  };

  const statBoxStyle = {
    textAlign: 'center',
    padding: '10px 8px',
    borderRadius: '6px',
    backgroundColor: '#fff',
    border: '1px solid #e2e8f0',
  };

  const statValueStyle = {
    fontSize: '20px',
    fontWeight: 700,
    margin: 0,
  };

  const statLabelStyle = {
    fontSize: '11px',
    color: '#718096',
    marginTop: '2px',
  };

  const barContainerStyle = {
    display: 'flex',
    height: '20px',
    borderRadius: '4px',
    overflow: 'hidden',
    marginBottom: '6px',
  };

  // ── Render helpers ──────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div style={panelStyle}>
        <p style={{ color: '#718096', margin: 0 }}>Loading quality report...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ ...panelStyle, borderColor: '#feb2b2' }}>
        <p style={{ color: '#e53e3e', margin: 0 }}>Quality report error: {error}</p>
      </div>
    );
  }

  if (!report || report.totalBullets === 0) {
    return (
      <div style={panelStyle}>
        <h4 style={titleStyle}>Bullet Quality</h4>
        <p style={{ color: '#a0aec0', margin: '8px 0 0' }}>
          No bullet edit data yet. Quality metrics will appear as you approve, edit, or discard generated bullets.
        </p>
      </div>
    );
  }

  const {
    totalBullets = 0,
    usableRate = 0,
    meanSimilarity = 0,
    percentiles = {},
    distribution = {},
    actionBreakdown = {},
  } = report;
  const medianSimilarity = percentiles.p50 ?? 0;

  const pct = (n) => `${Math.round(n * 100)}%`;
  const distTotal = totalBullets || 1;

  const bucketColors = {
    pristine: '#48bb78',
    minor_edit: '#68d391',
    moderate_edit: '#ecc94b',
    rewritten: '#fc8181',
  };

  const bucketLabels = {
    pristine: 'Pristine',
    minor_edit: 'Minor edit',
    moderate_edit: 'Moderate edit',
    rewritten: 'Rewritten',
  };

  // Usability color: green if ≥70%, yellow if ≥50%, red otherwise
  const usableColor =
    usableRate >= 0.7 ? '#48bb78' : usableRate >= 0.5 ? '#ecc94b' : '#fc8181';

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <h4 style={titleStyle}>Bullet Quality Tracking</h4>
        <select
          style={selectStyle}
          value={daysBack}
          onChange={(e) => setDaysBack(parseInt(e.target.value, 10))}
        >
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={0}>All time</option>
        </select>
      </div>

      {/* ── Key metrics ── */}
      <div style={statGridStyle}>
        <div style={statBoxStyle}>
          <p style={{ ...statValueStyle, color: usableColor }}>{pct(usableRate)}</p>
          <p style={statLabelStyle}>Usable rate</p>
        </div>
        <div style={statBoxStyle}>
          <p style={statValueStyle}>{pct(meanSimilarity)}</p>
          <p style={statLabelStyle}>Mean similarity</p>
        </div>
        <div style={statBoxStyle}>
          <p style={statValueStyle}>{pct(medianSimilarity)}</p>
          <p style={statLabelStyle}>Median similarity</p>
        </div>
        <div style={statBoxStyle}>
          <p style={statValueStyle}>{totalBullets}</p>
          <p style={statLabelStyle}>Total tracked</p>
        </div>
      </div>

      {/* ── Distribution bar ── */}
      <div>
        <p style={{ fontSize: '12px', fontWeight: 600, color: '#4a5568', marginBottom: '4px' }}>
          Edit distribution
        </p>
        <div style={barContainerStyle}>
          {['pristine', 'minor_edit', 'moderate_edit', 'rewritten'].map((bucket) => {
            const count = distribution[bucket] ?? 0;
            const widthPct = (count / distTotal) * 100;
            if (widthPct < 0.5) return null;
            return (
              <div
                key={bucket}
                title={`${bucketLabels[bucket]}: ${count} (${Math.round(widthPct)}%)`}
                style={{
                  width: `${widthPct}%`,
                  backgroundColor: bucketColors[bucket],
                  minWidth: count > 0 ? '2px' : 0,
                  transition: 'width 0.3s ease',
                }}
              />
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          {['pristine', 'minor_edit', 'moderate_edit', 'rewritten'].map((bucket) => {
            const count = distribution[bucket] ?? 0;
            return (
              <span key={bucket} style={{ fontSize: '11px', color: '#718096', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span
                  style={{
                    display: 'inline-block',
                    width: '8px',
                    height: '8px',
                    borderRadius: '2px',
                    backgroundColor: bucketColors[bucket],
                  }}
                />
                {bucketLabels[bucket]}: {count}
              </span>
            );
          })}
        </div>
      </div>

      {/* ── Action breakdown ── */}
      {(actionBreakdown.approved > 0 || actionBreakdown.edited > 0 || actionBreakdown.discarded > 0) && (
        <div style={{ marginTop: '12px' }}>
          <p style={{ fontSize: '12px', fontWeight: 600, color: '#4a5568', marginBottom: '4px' }}>
            Action breakdown
          </p>
          <div style={{ display: 'flex', gap: '16px', fontSize: '12px', color: '#4a5568' }}>
            <span>Approved: {actionBreakdown.approved ?? 0}</span>
            <span>Edited: {actionBreakdown.edited ?? 0}</span>
            <span>Discarded: {actionBreakdown.discarded ?? 0}</span>
          </div>
        </div>
      )}

      {/* ── Target indicator ── */}
      <div style={{ marginTop: '12px', padding: '8px', borderRadius: '4px', backgroundColor: usableRate >= 0.7 ? '#f0fff4' : '#fffff0', border: `1px solid ${usableRate >= 0.7 ? '#c6f6d5' : '#fefcbf'}` }}>
        <p style={{ margin: 0, fontSize: '12px', color: usableRate >= 0.7 ? '#276749' : '#744210' }}>
          {usableRate >= 0.7
            ? `Target met: ${pct(usableRate)} of bullets are usable with minimal editing (target: 70%+)`
            : `Below target: ${pct(usableRate)} usable (target: 70%+). Bullet generation quality may need improvement.`}
        </p>
      </div>
    </div>
  );
}
