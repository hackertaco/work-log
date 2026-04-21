import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(__dirname, 'ResumeChatPage.jsx'), 'utf-8');

describe('ResumeChatPage — candidate handoff flow', () => {
  test('reads candidateId from the URL search params', () => {
    assert.ok(
      source.includes("new URLSearchParams(window.location.search).get('candidateId')"),
      'should look for candidateId in the current URL'
    );
  });

  test('loads handoff context from the resume candidates API', () => {
    assert.ok(
      source.includes("/api/resume/candidates/${encodeURIComponent(candidateId)}/handoff"),
      'should fetch the candidate handoff payload from the backend'
    );
  });

  test('renders CandidateHandoffPanel before the main chat intro', () => {
    assert.ok(
      source.includes('CandidateHandoffPanel'),
      'should render a dedicated candidate handoff card'
    );
    assert.ok(
      source.includes('FROM BATCH FEED'),
      'should explain that the flow originated from the batch feed'
    );
  });

  test('starts chat from the backend-provided prompt', () => {
    assert.ok(
      source.includes('candidateHandoff?.handoff?.prompt'),
      'should read the prompt from the handoff payload'
    );
    assert.ok(
      source.includes('const parsed = parseResumeQuery(prompt)'),
      'should convert the handoff prompt into a normal chat submission'
    );
  });
});
