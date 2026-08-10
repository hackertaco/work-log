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

describe('ResumeChatPage — cost safety', () => {
  test('loads an existing draft without auto-generating on mount', () => {
    assert.ok(
      source.includes('useDraftContext({ autoGenerate: false })'),
      'page mount must be cache-only'
    );
  });

  test('uses the server-injected LLM capability for draft generation', () => {
    assert.ok(source.includes('window.__LLM_GENERATION_ENABLED'));
    assert.ok(source.includes('window.__LLM_GENERATION_ENABLED === true'));
    assert.ok(source.includes('import.meta.env.DEV'));
    assert.ok(source.includes('generationEnabled={LLM_GENERATION_ENABLED}'));
    assert.ok(source.includes('onRetry={LLM_GENERATION_ENABLED ? insightRetry : undefined}'));
  });

  test('disables the removed legacy chat path unless the local agent is enabled', () => {
    assert.ok(source.includes('disabled={!AGENT_ENABLED}'));
    assert.ok(source.includes('채팅은 로컬 CLIProxy에서만 사용할 수 있어요'));
  });

  test('does not claim a draft is ready when only the cache lookup completed', () => {
    assert.ok(source.includes('insightDraft={insightDraft}'));
    assert.ok(source.includes("insightStatus === 'ready' && insightDraft"));
  });
});
