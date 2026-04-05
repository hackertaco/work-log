/**
 * Tests for InlineSourceBadge component & parseInlineCitations utility
 *
 * Uses Node.js built-in test runner — no external dependencies.
 * Source-level contract tests + pure function unit tests.
 *
 * Run: node --test frontend/src/components/resume/chat/InlineSourceBadge.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(__dirname, 'InlineSourceBadge.jsx'), 'utf-8');

// ─── parseInlineCitations: 직접 import하여 순수 함수 테스트 ─────────────────
// InlineSourceBadge.jsx는 JSX를 포함하므로 Node.js에서 직접 import할 수 없다.
// parseInlineCitations 로직을 여기에 재현하여 동일 알고리즘을 검증한다.

/**
 * parseInlineCitations 로직 미러 (InlineSourceBadge.jsx에서 추출)
 */
function parseInlineCitations(content, citations) {
  if (!content || !Array.isArray(citations) || citations.length === 0) {
    return [{ type: 'text', value: content || '' }];
  }

  const parts = [];
  const pattern = /(?:«cite:(\d+)»|\[cite:(\d+)\])/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(content)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: content.slice(lastIndex, match.index) });
    }

    const idx = parseInt(match[1] ?? match[2], 10);
    const citation = idx >= 1 && idx <= citations.length ? citations[idx - 1] : null;

    if (citation) {
      parts.push({ type: 'cite', index: idx, citation });
    } else {
      parts.push({ type: 'text', value: match[0] });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    parts.push({ type: 'text', value: content.slice(lastIndex) });
  }

  return parts.length > 0 ? parts : [{ type: 'text', value: content }];
}

// ─── 테스트 픽스처 ──────────────────────────────────────────────────────────

const mockCitations = [
  { id: 'cite-commit-1', source: 'commits', date: '2024-03-01', text: '커밋 내용' },
  { id: 'cite-slack-1', source: 'slack', date: '2024-03-02', text: '슬랙 메시지' },
  { id: 'cite-session-1', source: 'session', date: '2024-03-03', text: '세션 메모' },
];

// ─── Source-level contract tests ────────────────────────────────────────────

describe('InlineSourceBadge — exports & structure', () => {
  test('exports InlineSourceBadge as a named export', () => {
    assert.ok(
      source.includes('export function InlineSourceBadge'),
      'should export InlineSourceBadge function',
    );
  });

  test('exports parseInlineCitations as a named export', () => {
    assert.ok(
      source.includes('export function parseInlineCitations'),
      'should export parseInlineCitations function',
    );
  });

  test('accepts citation and index props', () => {
    assert.ok(source.includes('citation'), 'should reference citation prop');
    assert.ok(source.includes('index'), 'should reference index prop');
  });

  test('renders badge variants for commit, slack, and session sources', () => {
    assert.ok(source.includes('isb-badge--commit'), 'should have commit badge style');
    assert.ok(source.includes('isb-badge--slack'), 'should have slack badge style');
    assert.ok(source.includes('isb-badge--session'), 'should have session badge style');
  });

  test('renders a popover with citation details', () => {
    assert.ok(source.includes('CitationPopover'), 'should render CitationPopover');
    assert.ok(source.includes('isb-popover'), 'should have popover CSS class');
  });

  test('has keyboard accessibility (Escape to close)', () => {
    assert.ok(source.includes("e.key === 'Escape'"), 'should handle Escape key');
    assert.ok(source.includes('onFocus'), 'should handle focus events');
    assert.ok(source.includes('onBlur'), 'should handle blur events');
  });

  test('has aria attributes for accessibility', () => {
    assert.ok(source.includes('aria-label'), 'should have aria-label');
    assert.ok(source.includes('aria-expanded'), 'should have aria-expanded');
    assert.ok(source.includes('aria-haspopup'), 'should have aria-haspopup');
    assert.ok(source.includes('role="tooltip"'), 'popover should have tooltip role');
  });

  test('shows relevance bar in popover', () => {
    assert.ok(source.includes('isb-relevance-bar'), 'should render relevance bar');
    assert.ok(source.includes('isb-relevance-label'), 'should render relevance label');
  });

  test('shows matched keywords in popover', () => {
    assert.ok(source.includes('isb-keyword-tag'), 'should render keyword tags');
    assert.ok(source.includes('matchedKeywords'), 'should use matchedKeywords');
  });

  test('shows source-specific metadata (hash, permalink, sessionType)', () => {
    assert.ok(source.includes('isb-meta-hash'), 'should show commit hash');
    assert.ok(source.includes('isb-meta-link'), 'should show slack link');
    assert.ok(source.includes('isb-meta-chip'), 'should show metadata chip');
  });

  test('hides badges in print media', () => {
    assert.ok(source.includes('@media print'), 'should have print media query');
  });

  test('positions popover with screen boundary correction', () => {
    assert.ok(source.includes('getBoundingClientRect'), 'should check element bounds');
    assert.ok(source.includes('window.innerWidth'), 'should check viewport width');
  });
});

// ─── parseInlineCitations unit tests ────────────────────────────────────────

describe('parseInlineCitations — pure function tests', () => {
  test('returns text-only part when no citations', () => {
    const result = parseInlineCitations('Hello world', []);
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'text');
    assert.equal(result[0].value, 'Hello world');
  });

  test('returns text-only part when content is null', () => {
    const result = parseInlineCitations(null, mockCitations);
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'text');
    assert.equal(result[0].value, '');
  });

  test('returns text-only part when citations is null', () => {
    const result = parseInlineCitations('Hello', null);
    assert.equal(result.length, 1);
    assert.equal(result[0].value, 'Hello');
  });

  test('parses «cite:N» markers into cite parts', () => {
    const content = '이 프로젝트는 «cite:1» 커밋에서 확인됩니다.';
    const result = parseInlineCitations(content, mockCitations);

    assert.equal(result.length, 3);
    assert.equal(result[0].type, 'text');
    assert.equal(result[0].value, '이 프로젝트는 ');
    assert.equal(result[1].type, 'cite');
    assert.equal(result[1].index, 1);
    assert.equal(result[1].citation.source, 'commits');
    assert.equal(result[2].type, 'text');
    assert.equal(result[2].value, ' 커밋에서 확인됩니다.');
  });

  test('parses [cite:N] markers into cite parts', () => {
    const content = '슬랙에서 논의됨 [cite:2].';
    const result = parseInlineCitations(content, mockCitations);

    assert.equal(result.length, 3);
    assert.equal(result[1].type, 'cite');
    assert.equal(result[1].index, 2);
    assert.equal(result[1].citation.source, 'slack');
  });

  test('handles multiple citations in one message', () => {
    const content = '커밋 «cite:1» 과 슬랙 «cite:2» 에서 확인됨.';
    const result = parseInlineCitations(content, mockCitations);

    const cites = result.filter((p) => p.type === 'cite');
    assert.equal(cites.length, 2);
    assert.equal(cites[0].index, 1);
    assert.equal(cites[1].index, 2);
  });

  test('handles invalid citation index as text', () => {
    const content = '없는 출처 «cite:99» 참조';
    const result = parseInlineCitations(content, mockCitations);

    // «cite:99»는 유효하지 않으므로 텍스트로 유지
    const texts = result.filter((p) => p.type === 'text');
    assert.ok(texts.some((t) => t.value.includes('«cite:99»')));
  });

  test('handles zero index as text (1-based only)', () => {
    const content = '무효 «cite:0» 참조';
    const result = parseInlineCitations(content, mockCitations);

    const cites = result.filter((p) => p.type === 'cite');
    assert.equal(cites.length, 0);
  });

  test('handles mixed «cite:N» and [cite:N] formats', () => {
    const content = '커밋 «cite:1» 과 세션 [cite:3]';
    const result = parseInlineCitations(content, mockCitations);

    const cites = result.filter((p) => p.type === 'cite');
    assert.equal(cites.length, 2);
    assert.equal(cites[0].citation.source, 'commits');
    assert.equal(cites[1].citation.source, 'session');
  });

  test('handles content with no markers', () => {
    const content = '마커가 없는 일반 텍스트입니다.';
    const result = parseInlineCitations(content, mockCitations);

    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'text');
    assert.equal(result[0].value, content);
  });

  test('handles citation at start of content', () => {
    const content = '«cite:1» 시작 위치';
    const result = parseInlineCitations(content, mockCitations);

    assert.equal(result[0].type, 'cite');
    assert.equal(result[0].index, 1);
  });

  test('handles citation at end of content', () => {
    const content = '끝 위치 «cite:3»';
    const result = parseInlineCitations(content, mockCitations);

    const last = result[result.length - 1];
    assert.equal(last.type, 'cite');
    assert.equal(last.index, 3);
  });

  test('handles adjacent citations without text between', () => {
    const content = '«cite:1»«cite:2»';
    const result = parseInlineCitations(content, mockCitations);

    assert.equal(result.length, 2);
    assert.equal(result[0].type, 'cite');
    assert.equal(result[1].type, 'cite');
  });
});

// ─── SourceCitations source contract tests ──────────────────────────────────

describe('SourceCitations — source contract', () => {
  const scSource = readFileSync(resolve(__dirname, 'SourceCitations.jsx'), 'utf-8');

  test('exports SourceCitations as a named export', () => {
    assert.ok(
      scSource.includes('export function SourceCitations'),
      'should export SourceCitations function',
    );
  });

  test('renders commit, slack, and session citation variants', () => {
    assert.ok(scSource.includes('CommitCitation'), 'should have CommitCitation');
    assert.ok(scSource.includes('SlackCitation'), 'should have SlackCitation');
    assert.ok(scSource.includes('SessionCitation'), 'should have SessionCitation');
  });

  test('supports expand/collapse for long citation lists', () => {
    assert.ok(scSource.includes('expanded'), 'should track expanded state');
    assert.ok(scSource.includes('sc-toggle'), 'should have toggle button');
    assert.ok(scSource.includes('maxVisible'), 'should accept maxVisible prop');
  });

  test('shows matched keywords as tags', () => {
    assert.ok(scSource.includes('sc-keyword-tag'), 'should render keyword tags');
    assert.ok(scSource.includes('matchedKeywords'), 'should use matchedKeywords');
  });

  test('shows preview toggle for text snippets', () => {
    assert.ok(scSource.includes('sc-preview-toggle'), 'should have preview toggle');
    assert.ok(scSource.includes('sc-preview'), 'should have preview container');
  });

  test('renders external links for Slack permalinks', () => {
    assert.ok(scSource.includes('target="_blank"'), 'should open Slack links in new tab');
    assert.ok(scSource.includes('rel="noopener noreferrer"'), 'should have secure rel');
  });

  test('uses consistent color scheme for source badges', () => {
    assert.ok(scSource.includes('#dbeafe'), 'commits bg color (blue)');
    assert.ok(scSource.includes('#1e40af'), 'commits text color');
    assert.ok(scSource.includes('#fef3c7'), 'slack bg color (amber)');
    assert.ok(scSource.includes('#92400e'), 'slack text color');
    assert.ok(scSource.includes('#d1fae5'), 'session bg color (green)');
    assert.ok(scSource.includes('#065f46'), 'session text color');
  });

  test('has aria-label for accessibility', () => {
    assert.ok(scSource.includes('aria-label="출처 정보"'), 'root should have aria-label');
  });
});
