import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const resumeBodySource = fs.readFileSync(
  new URL('./ResumeBody.jsx', import.meta.url),
  'utf8',
);

const resumeMainViewSource = fs.readFileSync(
  new URL('./ResumeMainView.jsx', import.meta.url),
  'utf8',
);

test('ResumeBody accepts companyStories and renders inline company project blocks', () => {
  assert.match(resumeBodySource, /companyStories = \[\]/, 'should accept companyStories prop');
  assert.match(resumeBodySource, /CompanyStoryInlineBlock/, 'should render company story inline block');
  assert.match(resumeBodySource, /대표 프로젝트/, 'should expose representative projects label');
  assert.match(resumeBodySource, /이 회사에서 증명된 역량/, 'should expose proven capabilities label');
});

test('ResumeMainView fetches chat draft stories and passes them to ResumeBody', () => {
  assert.match(
    resumeMainViewSource,
    /fetch\('\/api\/resume\/chat\/generate-draft'/,
    'should fetch chat draft stories',
  );
  assert.match(
    resumeMainViewSource,
    /companyStories=\{companyStories\}/,
    'should pass companyStories into ResumeBody',
  );
});
