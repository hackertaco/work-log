/**
 * Tests for DraftInsightMessages component
 *
 * Uses Node.js built-in test runner — no external dependencies.
 * Source-level contract tests that verify the component's exports,
 * structure, and rendering logic patterns.
 *
 * Run: node --test frontend/src/components/resume/chat/DraftInsightMessages.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(__dirname, 'DraftInsightMessages.jsx'), 'utf-8');

// ─── Source-level contract tests ─────────────────────────────────────────────

describe('DraftInsightMessages — exports & props', () => {
  test('exports DraftInsightMessages as a named export', () => {
    assert.ok(
      source.includes('export function DraftInsightMessages'),
      'should export DraftInsightMessages function'
    );
  });

  test('accepts draft prop', () => {
    assert.ok(source.includes('draft'), 'should reference draft prop');
  });

  test('accepts status prop with default "loading"', () => {
    assert.ok(
      source.includes("status = 'loading'"),
      'should have default status of loading'
    );
  });

  test('accepts error prop with default null', () => {
    assert.ok(
      source.includes('error = null'),
      'should have default error of null'
    );
  });

  test('accepts onRetry callback', () => {
    assert.ok(source.includes('onRetry'), 'should reference onRetry prop');
  });

  test('accepts onStrengthClick callback', () => {
    assert.ok(source.includes('onStrengthClick'), 'should reference onStrengthClick prop');
  });

  test('accepts onExperienceClick callback', () => {
    assert.ok(source.includes('onExperienceClick'), 'should reference onExperienceClick prop');
  });
});

describe('DraftInsightMessages — state rendering', () => {
  test('renders loading state for "loading" and "generating" statuses', () => {
    assert.ok(
      source.includes("status === 'loading'") || source.includes("status === 'generating'"),
      'should check for loading/generating status'
    );
    assert.ok(
      source.includes('InsightLoadingMessage'),
      'should render InsightLoadingMessage for loading states'
    );
  });

  test('renders error state with retry button', () => {
    assert.ok(
      source.includes("status === 'error'"),
      'should check for error status'
    );
    assert.ok(
      source.includes('InsightErrorMessage'),
      'should render InsightErrorMessage for error state'
    );
  });

  test('returns null when draft is falsy', () => {
    assert.ok(
      source.includes('if (!draft) return null'),
      'should return null when no draft data'
    );
  });

  test('returns null when no strength or experience content', () => {
    assert.ok(
      source.includes('if (!hasContent) return null'),
      'should return null when no content to display'
    );
  });
});

describe('DraftInsightMessages — draft data destructuring', () => {
  test('destructures strengthCandidates from draft', () => {
    assert.ok(
      source.includes('strengthCandidates'),
      'should reference strengthCandidates'
    );
  });

  test('destructures experienceSummaries from draft', () => {
    assert.ok(
      source.includes('experienceSummaries'),
      'should reference experienceSummaries'
    );
  });

  test('destructures suggestedSummary from draft', () => {
    assert.ok(
      source.includes('suggestedSummary'),
      'should reference suggestedSummary'
    );
  });

  test('destructures dataGaps from draft', () => {
    assert.ok(
      source.includes('dataGaps'),
      'should reference dataGaps'
    );
  });

  test('destructures sources from draft', () => {
    assert.ok(
      source.includes('sources'),
      'should reference sources for metadata display'
    );
  });

  test('destructures dateRange from draft', () => {
    assert.ok(
      source.includes('dateRange'),
      'should reference dateRange for period display'
    );
  });
});

describe('DraftInsightMessages — sections rendering', () => {
  test('renders InsightHeaderMessage with source metadata', () => {
    assert.ok(
      source.includes('InsightHeaderMessage'),
      'should render header message with analysis summary'
    );
  });

  test('renders suggested summary as blockquote', () => {
    assert.ok(
      source.includes('dim-summary-quote'),
      'should render suggested summary in a blockquote'
    );
  });

  test('renders strength candidates section with count badge', () => {
    assert.ok(
      source.includes('핵심 강점 후보'),
      'should label section as 핵심 강점 후보'
    );
    assert.ok(
      source.includes('dim-count-badge'),
      'should display count badge'
    );
  });

  test('renders experience summaries section', () => {
    assert.ok(
      source.includes('경력별 주요 경험'),
      'should label section as 경력별 주요 경험'
    );
  });

  test('renders data gaps as warning section', () => {
    assert.ok(
      source.includes('보충이 필요한 항목'),
      'should label gap section as 보충이 필요한 항목'
    );
    assert.ok(
      source.includes("variant=\"warning\"") || source.includes("variant='warning'"),
      'should use warning variant for data gaps bubble'
    );
  });
});

describe('StrengthCandidateChip — internal component', () => {
  test('renders strength label', () => {
    assert.ok(
      source.includes('dim-str-label'),
      'should render strength label text'
    );
  });

  test('renders frequency badge when frequency > 1', () => {
    assert.ok(
      source.includes('frequency > 1'),
      'should conditionally render frequency badge'
    );
    assert.ok(
      source.includes('dim-freq-badge'),
      'should have freq badge CSS class'
    );
  });

  test('renders description when present', () => {
    assert.ok(
      source.includes('dim-str-desc'),
      'should render description paragraph'
    );
  });

  test('renders behavior cluster chips (max 4)', () => {
    assert.ok(
      source.includes('behaviorCluster.slice(0, 4)'),
      'should show max 4 behavior cluster chips'
    );
    assert.ok(
      source.includes('behaviorCluster.length > 4'),
      'should show overflow indicator for >4 clusters'
    );
  });

  test('has expandable evidence list', () => {
    assert.ok(
      source.includes('dim-evidence-toggle'),
      'should have toggle button for evidence'
    );
    assert.ok(
      source.includes('dim-evidence-list'),
      'should render evidence list when expanded'
    );
  });

  test('calls onStrengthClick when clicked', () => {
    assert.ok(
      source.includes('onClick={onStrengthClick}') || source.includes('onClick(candidate)'),
      'should call onStrengthClick callback'
    );
  });

  test('supports keyboard accessibility (Enter key)', () => {
    assert.ok(
      source.includes("e.key === 'Enter'"),
      'should handle Enter key for accessibility'
    );
  });

  test('has role="button" for a11y', () => {
    assert.ok(
      source.includes('role="button"'),
      'should have button role for screen readers'
    );
  });

  test('has tabIndex={0} for keyboard navigation', () => {
    assert.ok(
      source.includes('tabIndex={0}'),
      'should be focusable via tab'
    );
  });
});

describe('ExperienceSummaryChip — internal component', () => {
  test('renders company name', () => {
    assert.ok(
      source.includes('dim-exp-company'),
      'should render company name'
    );
  });

  test('renders activity dates count', () => {
    assert.ok(
      source.includes('dates.length'),
      'should reference dates count'
    );
  });

  test('renders highlights (max 3)', () => {
    assert.ok(
      source.includes('highlights.slice(0, 3)'),
      'should show max 3 highlights'
    );
    assert.ok(
      source.includes('highlights.length > 3'),
      'should show overflow indicator for >3 highlights'
    );
  });

  test('renders skill chips (max 5)', () => {
    assert.ok(
      source.includes('skills.slice(0, 5)'),
      'should show max 5 skill chips'
    );
    assert.ok(
      source.includes('skills.length > 5'),
      'should show overflow indicator for >5 skills'
    );
  });

  test('has expandable suggested bullets list', () => {
    assert.ok(
      source.includes('suggestedBullets'),
      'should reference suggestedBullets'
    );
    assert.ok(
      source.includes('showBullets'),
      'should track expanded state for bullets'
    );
  });

  test('calls onExperienceClick when clicked', () => {
    assert.ok(
      source.includes('onClick={onExperienceClick}') || source.includes('onClick(summary)'),
      'should call onExperienceClick callback'
    );
  });
});

describe('InsightBubble — chat message appearance', () => {
  test('renders AI avatar to match assistant messages', () => {
    assert.ok(
      source.includes('dim-avatar'),
      'should render avatar element'
    );
    // Avatar text should be "AI" consistent with ResumeChatMessages
    assert.ok(
      source.includes('>AI<'),
      'should display "AI" in avatar'
    );
  });

  test('uses chat bubble styling (dim-bubble)', () => {
    assert.ok(
      source.includes('dim-bubble'),
      'should use bubble CSS class for chat appearance'
    );
  });

  test('supports warning variant for data gaps', () => {
    assert.ok(
      source.includes('dim-bubble--warning'),
      'should apply warning class for data gap bubbles'
    );
  });
});

describe('InsightLoadingMessage — loading UX', () => {
  test('shows spinner during loading', () => {
    assert.ok(
      source.includes('dim-loading-spinner'),
      'should show loading spinner'
    );
  });

  test('shows different text for loading vs generating', () => {
    assert.ok(
      source.includes('업무 로그에서 강점·경력 초안 생성 중'),
      'should show generating-specific text'
    );
    assert.ok(
      source.includes('초안 데이터 불러오는 중'),
      'should show loading-specific text'
    );
  });

  test('mentions 30-second timeout for generating', () => {
    assert.ok(
      source.includes('최대 30초'),
      'should inform user about max generation time'
    );
  });

  test('has aria-busy attribute', () => {
    assert.ok(
      source.includes('aria-busy="true"'),
      'should set aria-busy for loading state'
    );
  });
});

describe('InsightHeaderMessage — analysis summary', () => {
  test('displays commit count', () => {
    assert.ok(
      source.includes('commitCount'),
      'should reference commitCount from sources'
    );
  });

  test('displays slack count', () => {
    assert.ok(
      source.includes('slackCount'),
      'should reference slackCount from sources'
    );
  });

  test('displays session count', () => {
    assert.ok(
      source.includes('sessionCount'),
      'should reference sessionCount from sources'
    );
  });

  test('displays date range', () => {
    assert.ok(
      source.includes('dateFrom') && source.includes('dateTo'),
      'should extract and display date range'
    );
  });

  test('shows clickability hint', () => {
    assert.ok(
      source.includes('클릭하면 해당 내용으로 채팅을 이어갈 수 있습니다'),
      'should show hint about clicking items to start chat'
    );
  });
});

describe('DraftInsightMessages — CSS styling', () => {
  test('includes scoped CSS via DIM_CSS', () => {
    assert.ok(
      source.includes('DIM_CSS'),
      'should define DIM_CSS for scoped styles'
    );
  });

  test('uses fade-in animation', () => {
    assert.ok(
      source.includes('dim-fade-in'),
      'should apply entrance animation'
    );
  });

  test('has responsive styles for mobile', () => {
    assert.ok(
      source.includes('@media (max-width: 600px)'),
      'should include responsive breakpoint for mobile'
    );
  });

  test('uses design-system CSS variables', () => {
    assert.ok(
      source.includes('var(--space-'),
      'should use spacing variables from design system'
    );
    assert.ok(
      source.includes('var(--accent)'),
      'should use accent color variable'
    );
    assert.ok(
      source.includes('var(--ink)'),
      'should use ink color variable'
    );
    assert.ok(
      source.includes('var(--muted)'),
      'should use muted color variable'
    );
  });

  test('hover styles for interactive cards', () => {
    assert.ok(
      source.includes('.dim-str-card:hover'),
      'should have hover styles for strength cards'
    );
    assert.ok(
      source.includes('.dim-exp-card:hover'),
      'should have hover styles for experience cards'
    );
  });

  test('focus-visible styles for keyboard accessibility', () => {
    assert.ok(
      source.includes('focus-visible'),
      'should have focus-visible styles for a11y'
    );
  });
});

describe('DraftInsightMessages — integration contract', () => {
  test('uses Preact useState hook for expand/collapse state', () => {
    assert.ok(
      source.includes("import { useState } from 'preact/hooks'"),
      'should import useState from preact/hooks'
    );
  });

  test('chat bubble max-width matches ResumeChatMessages (720px row)', () => {
    assert.ok(
      source.includes('max-width: 720px'),
      'should constrain row width to 720px like chat messages'
    );
  });

  test('avatar styling matches ResumeChatMessages assistant avatar', () => {
    // Both use #1e40af blue background, 28px size, 10px font
    assert.ok(
      source.includes('width: 28px') && source.includes('height: 28px'),
      'should have 28px avatar matching chat messages'
    );
    assert.ok(
      source.includes('#1e40af'),
      'should use same blue color as chat avatar'
    );
  });
});
