/**
 * Tests for resumeJsonDiff.js
 *
 * Uses Node.js built-in test runner — no external dependencies.
 *
 * Note: The source file is a .js module (ESM), imported directly.
 * Run: node --test frontend/src/lib/resumeJsonDiff.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ESM import using file URL resolution
import { computeResumeJsonDiff, countTotalChanges } from './resumeJsonDiff.js';

// ─── Test fixtures ─────────────────────────────────────────────────────────────

function makeResume(overrides = {}) {
  return {
    meta: { language: 'ko', schemaVersion: 1, generatedAt: '2024-01-01T00:00:00Z' },
    contact: {
      name: '김개발',
      email: 'dev@example.com',
      phone: null,
      location: '서울',
      website: null,
      linkedin: null,
    },
    summary: '풀스택 개발자로 5년 경력',
    experience: [
      {
        _source: 'user',
        company: '테크 주식회사',
        title: '시니어 개발자',
        start_date: '2021-03',
        end_date: 'present',
        location: '서울',
        bullets: ['React 기반 대시보드 개발', 'API 성능 30% 개선'],
      },
    ],
    education: [
      {
        institution: '서울대학교',
        degree: '학사',
        field: '컴퓨터공학',
        start_date: '2015-03',
        end_date: '2019-02',
        gpa: null,
      },
    ],
    skills: {
      technical: ['React', 'Node.js', 'TypeScript'],
      languages: ['JavaScript', 'Python'],
      tools: ['Git', 'Docker'],
    },
    projects: [],
    certifications: [],
    strength_keywords: ['문제 해결', '코드 품질', '커뮤니케이션'],
    display_axes: [],
    ...overrides,
  };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe('computeResumeJsonDiff', () => {
  test('동일한 문서 → 빈 배열 반환', () => {
    const doc = makeResume();
    const result = computeResumeJsonDiff(doc, doc);
    assert.deepEqual(result, []);
  });

  test('null/undefined 입력 → 빈 배열 반환', () => {
    const doc = makeResume();
    assert.deepEqual(computeResumeJsonDiff(null, doc), []);
    assert.deepEqual(computeResumeJsonDiff(doc, null), []);
    assert.deepEqual(computeResumeJsonDiff(undefined, undefined), []);
  });

  test('contact 섹션 이메일 변경 감지', () => {
    const original = makeResume();
    const modified = makeResume({ contact: { ...original.contact, email: 'new@example.com' } });

    const diffs = computeResumeJsonDiff(original, modified);
    const contactDiff = diffs.find((d) => d.key === 'contact');

    assert.ok(contactDiff, 'contact diff가 있어야 한다');
    assert.equal(contactDiff.type, 'scalar');
    const emailChange = contactDiff.fields.find((f) => f.field === 'email');
    assert.ok(emailChange, 'email 필드 변경이 있어야 한다');
    assert.equal(emailChange.type, 'modified');
    assert.equal(emailChange.before, 'dev@example.com');
    assert.equal(emailChange.after, 'new@example.com');
  });

  test('contact 섹션 새 필드 추가 감지 (phone)', () => {
    const original = makeResume();
    const modified = makeResume({ contact: { ...original.contact, phone: '010-1234-5678' } });

    const diffs = computeResumeJsonDiff(original, modified);
    const contactDiff = diffs.find((d) => d.key === 'contact');

    assert.ok(contactDiff, 'contact diff가 있어야 한다');
    const phoneChange = contactDiff.fields.find((f) => f.field === 'phone');
    assert.ok(phoneChange, 'phone 필드 변경이 있어야 한다');
    assert.equal(phoneChange.type, 'added');
    assert.equal(phoneChange.before, null);
    assert.equal(phoneChange.after, '010-1234-5678');
  });

  test('summary 변경 감지', () => {
    const original = makeResume();
    const modified = makeResume({ summary: '풀스택 개발자로 7년 경력, AI/ML 경험 보유' });

    const diffs = computeResumeJsonDiff(original, modified);
    const summaryDiff = diffs.find((d) => d.key === 'summary');

    assert.ok(summaryDiff, 'summary diff가 있어야 한다');
    assert.equal(summaryDiff.type, 'text');
    assert.equal(summaryDiff.before, '풀스택 개발자로 5년 경력');
    assert.equal(summaryDiff.after, '풀스택 개발자로 7년 경력, AI/ML 경험 보유');
  });

  test('experience 불릿 추가 감지', () => {
    const original = makeResume();
    const modified = makeResume({
      experience: [
        {
          ...original.experience[0],
          bullets: [
            ...original.experience[0].bullets,
            '마이크로서비스 아키텍처 도입',
          ],
        },
      ],
    });

    const diffs = computeResumeJsonDiff(original, modified);
    const expDiff = diffs.find((d) => d.key === 'experience');

    assert.ok(expDiff, 'experience diff가 있어야 한다');
    assert.equal(expDiff.type, 'array');
    assert.equal(expDiff.modified.length, 1);

    const mod = expDiff.modified[0];
    const bulletChange = mod.fieldChanges.find((fc) => fc.field === 'bullets');
    assert.ok(bulletChange, 'bullets 변경이 있어야 한다');
    assert.equal(bulletChange.type, 'array');
    assert.ok(bulletChange.added.includes('마이크로서비스 아키텍처 도입'));
    assert.equal(bulletChange.deleted.length, 0);
  });

  test('experience 항목 추가 감지', () => {
    const original = makeResume();
    const modified = makeResume({
      experience: [
        ...original.experience,
        {
          company: '스타트업 ABC',
          title: '주니어 개발자',
          start_date: '2019-03',
          end_date: '2021-02',
          location: '서울',
          bullets: ['초기 서비스 개발'],
        },
      ],
    });

    const diffs = computeResumeJsonDiff(original, modified);
    const expDiff = diffs.find((d) => d.key === 'experience');

    assert.ok(expDiff, 'experience diff가 있어야 한다');
    assert.equal(expDiff.added.length, 1);
    assert.equal(expDiff.added[0].company, '스타트업 ABC');
    assert.ok(expDiff.userOwned !== true);
  });

  test('experience 항목 삭제 감지', () => {
    const original = makeResume({
      experience: [
        { company: '테크 주식회사', title: '시니어 개발자', start_date: '2021-03', end_date: 'present', location: '서울', bullets: [] },
        { company: '이전 회사', title: '개발자', start_date: '2019-01', end_date: '2021-02', location: '부산', bullets: [] },
      ],
    });
    const modified = makeResume({
      experience: [
        { company: '테크 주식회사', title: '시니어 개발자', start_date: '2021-03', end_date: 'present', location: '서울', bullets: [] },
      ],
    });

    const diffs = computeResumeJsonDiff(original, modified);
    const expDiff = diffs.find((d) => d.key === 'experience');

    assert.ok(expDiff, 'experience diff가 있어야 한다');
    assert.equal(expDiff.deleted.length, 1);
    assert.equal(expDiff.deleted[0].company, '이전 회사');
  });

  test('skills 기술 스택 추가/삭제 감지', () => {
    const original = makeResume();
    const modified = makeResume({
      skills: {
        technical: ['React', 'Vue.js', 'TypeScript'], // Node.js 삭제, Vue.js 추가
        languages: ['JavaScript', 'Python'],
        tools: ['Git', 'Docker'],
      },
    });

    const diffs = computeResumeJsonDiff(original, modified);
    const skillsDiff = diffs.find((d) => d.key === 'skills');

    assert.ok(skillsDiff, 'skills diff가 있어야 한다');
    assert.equal(skillsDiff.type, 'skills');
    assert.ok(skillsDiff.technical.added.includes('Vue.js'));
    assert.ok(skillsDiff.technical.deleted.includes('Node.js'));
    assert.equal(skillsDiff.languages.added.length, 0);
    assert.equal(skillsDiff.languages.deleted.length, 0);
  });

  test('strength_keywords 변경 감지', () => {
    const original = makeResume();
    const modified = makeResume({
      strength_keywords: ['문제 해결', '코드 품질', '리더십'], // 커뮤니케이션 삭제, 리더십 추가
    });

    const diffs = computeResumeJsonDiff(original, modified);
    const kwDiff = diffs.find((d) => d.key === 'strength_keywords');

    assert.ok(kwDiff, 'strength_keywords diff가 있어야 한다');
    assert.equal(kwDiff.type, 'tags');
    assert.ok(kwDiff.added.includes('리더십'));
    assert.ok(kwDiff.deleted.includes('커뮤니케이션'));
  });

  test('변경 없는 섹션은 결과에 포함되지 않음', () => {
    const original = makeResume();
    const modified = makeResume({ summary: '새로운 요약' });

    const diffs = computeResumeJsonDiff(original, modified);
    const keys = diffs.map((d) => d.key);

    assert.ok(keys.includes('summary'), 'summary는 포함되어야 한다');
    assert.ok(!keys.includes('contact'), 'contact는 포함되지 않아야 한다');
    assert.ok(!keys.includes('experience'), 'experience는 포함되지 않아야 한다');
    assert.ok(!keys.includes('skills'), 'skills는 포함되지 않아야 한다');
  });
});

describe('countTotalChanges', () => {
  test('변경 없음 → 0', () => {
    assert.equal(countTotalChanges([]), 0);
  });

  test('scalar 섹션 필드 수 합산', () => {
    const diffs = [{
      key: 'contact',
      label: '연락처',
      type: 'scalar',
      fields: [
        { field: 'name', label: '이름', type: 'modified', before: 'A', after: 'B' },
        { field: 'email', label: '이메일', type: 'added', before: null, after: 'x@y.com' },
      ],
    }];
    assert.equal(countTotalChanges(diffs), 2);
  });

  test('text 섹션 → 1', () => {
    const diffs = [{
      key: 'summary',
      label: '자기소개',
      type: 'text',
      before: '이전',
      after: '이후',
    }];
    assert.equal(countTotalChanges(diffs), 1);
  });

  test('array 섹션 합산 (추가+삭제+수정)', () => {
    const diffs = [{
      key: 'experience',
      label: '경력',
      type: 'array',
      added: [{ company: 'A' }],
      deleted: [{ company: 'B' }, { company: 'C' }],
      modified: [{ key: 'x', label: 'X', before: {}, after: {}, fieldChanges: [] }],
    }];
    assert.equal(countTotalChanges(diffs), 4); // 1 + 2 + 1
  });

  test('skills 섹션 카테고리별 합산', () => {
    const diffs = [{
      key: 'skills',
      label: '기술',
      type: 'skills',
      technical: { added: ['Vue.js'], deleted: ['Node.js'], label: '기술 스택' },
      languages: { added: [], deleted: [], label: '프로그래밍 언어' },
      tools: { added: ['K8s'], deleted: [], label: '도구' },
    }];
    assert.equal(countTotalChanges(diffs), 3); // 2 + 0 + 1
  });

  test('tags 섹션 합산', () => {
    const diffs = [{
      key: 'strength_keywords',
      label: '강점 키워드',
      type: 'tags',
      added: ['리더십'],
      deleted: ['커뮤니케이션'],
    }];
    assert.equal(countTotalChanges(diffs), 2);
  });

  test('복합 diff 총합', () => {
    const doc1 = makeResume();
    const doc2 = makeResume({
      summary: '새로운 요약',
      skills: {
        technical: ['React', 'Vue.js'],  // Node.js 삭제, Vue.js 추가
        languages: ['JavaScript', 'Python'],
        tools: ['Git', 'Docker'],
      },
    });

    const diffs = computeResumeJsonDiff(doc1, doc2);
    const total = countTotalChanges(diffs);

    // summary: 1 + skills.technical: 3 (Vue.js 추가, Node.js·TypeScript 삭제) = 4
    assert.equal(total, 4);
  });
});
