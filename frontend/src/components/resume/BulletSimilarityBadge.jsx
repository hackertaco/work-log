import { useState, useEffect } from 'preact/hooks';

/**
 * BulletSimilarityBadge — Inline similarity score feedback after a bullet edit.
 *
 * Shows a small, animated badge indicating how much the user modified the
 * system-generated bullet. Fades out after a configurable duration.
 *
 * Props:
 *   similarityScore — { similarity, modificationDistance, isUsable, bucket, metrics }
 *                     (returned from PATCH /sections/.../bullets/... or PATCH /items)
 *   fadeDurationMs  — how long before the badge fades out (default: 5000)
 *
 * Bucket colors:
 *   pristine      → green  (≥95% similar)
 *   minor_edit    → teal   (85–95%)
 *   moderate_edit → amber  (50–85%)
 *   rewritten     → red    (<50%)
 */
export function BulletSimilarityBadge({ similarityScore, fadeDurationMs = 5000 }) {
  const [visible, setVisible] = useState(true);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    if (!similarityScore) return;
    setVisible(true);
    setFading(false);

    const fadeTimer = setTimeout(() => setFading(true), fadeDurationMs - 600);
    const hideTimer = setTimeout(() => setVisible(false), fadeDurationMs);

    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(hideTimer);
    };
  }, [similarityScore, fadeDurationMs]);

  if (!similarityScore || !visible) return null;

  const { similarity, bucket } = similarityScore;
  const pct = Math.round(similarity * 100);

  const bucketConfig = {
    pristine:      { color: '#276749', bg: '#f0fff4', border: '#c6f6d5', label: 'Pristine' },
    minor_edit:    { color: '#285e61', bg: '#e6fffa', border: '#b2f5ea', label: 'Minor edit' },
    moderate_edit: { color: '#744210', bg: '#fffff0', border: '#fefcbf', label: 'Moderate edit' },
    rewritten:     { color: '#9b2c2c', bg: '#fff5f5', border: '#fed7d7', label: 'Rewritten' },
  };

  const config = bucketConfig[bucket] || bucketConfig.moderate_edit;

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '2px 8px',
        borderRadius: '12px',
        fontSize: '11px',
        fontWeight: 500,
        color: config.color,
        backgroundColor: config.bg,
        border: `1px solid ${config.border}`,
        transition: 'opacity 0.5s ease',
        opacity: fading ? 0 : 1,
        whiteSpace: 'nowrap',
      }}
      title={`Similarity: ${pct}% — ${config.label} (Levenshtein: ${Math.round((similarityScore.metrics?.levenshtein ?? 0) * 100)}%, Jaccard: ${Math.round((similarityScore.metrics?.tokenJaccard ?? 0) * 100)}%)`}
    >
      <span style={{
        display: 'inline-block',
        width: '6px',
        height: '6px',
        borderRadius: '50%',
        backgroundColor: config.color,
      }} />
      {pct}% match
    </span>
  );
}
