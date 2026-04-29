import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWorklogShareSentence,
  deriveStoryTitle,
  sanitizeWorklogCopy,
  sanitizeWorklogList,
  splitCompactStoryHighlights,
} from './worklogCopy.js';

test('sanitizeWorklogCopy removes raw repo-like prefixes and boilerplate', () => {
  const result = sanitizeWorklogCopy('driving-teacher-frontend-CHORE-remove-unused-templates 관련 작업의 운영 안정성과 개발 생산성을 개선했다');
  assert.equal(result, '흐름을 더 안정적으로 정리했다');
});

test('sanitizeWorklogCopy rewrites repo+commit boilerplate into the actual change', () => {
  const result = sanitizeWorklogCopy('driving-teacher-review-bot에서 2개의 커밋을 통해 chore: remove diag endpoint, strip ping metadata init: 관련 작업을 진행했다.');
  assert.equal(result, 'remove diag endpoint, strip ping metadata init');
});

test('sanitizeWorklogCopy suppresses raw url-only noise', () => {
  const result = sanitizeWorklogCopy('https://www.linkedin.com/posts/example-long-noisy-url');
  assert.equal(result, '');
});

test('sanitizeWorklogList drops empty/url noise and keeps readable lines', () => {
  const result = sanitizeWorklogList([
    'https://www.linkedin.com/posts/example-long-noisy-url',
    'driving-teacher-ai-native에서 2개의 커밋을 통해 test: smoke 2 test: smoke test for driving-teacher-bot 관련 작업을 진행했다.',
    '운영 이슈를 기능 추가보다 안정화와 예외 처리 관점에서 푸는 경향이 강하게 보인다.',
  ], { maxItems: 3, maxLength: 96 });
  assert.deepEqual(result, [
    'smoke 2 test: smoke test for driving-teacher-bot',
    '운영 이슈를 기능 추가보다 안정화와 예외 처리 관점에서 푸는 경향이 강하게 보인다.',
  ]);
});

test('buildWorklogShareSentence prefers readable change + why phrasing', () => {
  const result = buildWorklogShareSentence({
    outcomes: ['driving-teacher-frontend-CHORE-remove-unused-templates 관련 작업의 운영 안정성과 개발 생산성을 개선했다'],
    whyItMatters: ['주요 기능 흐름의 오류 가능성을 줄임'],
    changes: ['미사용 템플릿과 연결 코드를 정리했다'],
  });
  assert.equal(result, '미사용 템플릿과 연결 코드를 정리했다. 그래서 주요 흐름의 오류 가능성을 줄였다.');
});

test('splitCompactStoryHighlights breaks raw changelog strings into readable bullets', () => {
  const items = splitCompactStoryHighlights('hydration error #418 — date/number locale 고정 refactor(analytics): Lv 기준 재설계 + 네이밍 정직화 feat(analytics): ProfileCard 추출 + WoW 주간 추이 차트');
  assert.ok(items.length >= 2);
  assert.ok(items[0].includes('hydration error #418'));
  assert.ok(items.some((item) => item.includes('refactor(analytics): Lv 기준 재설계')));
});

test('deriveStoryTitle prefers readable change titles over repo-based generic outcomes', () => {
  const result = deriveStoryTitle({
    repo: 'driving-teacher-frontend-CHORE-remove-unused-templates',
    outcome: 'driving-teacher-frontend-CHORE-remove-unused-templates에서 진행한 핵심 흐름을 정리하고 개선함',
    impact: '주요 흐름의 오류 가능성을 줄였다',
    why: '운영과 개발 모두에서 예외 상황 대응 비용을 줄일 수 있음',
    keyChange: '미사용 템플릿과 연결 코드를 정리했다',
  });
  assert.equal(result, '미사용 템플릿과 연결 코드를 정리했다');
});
