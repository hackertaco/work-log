import assert from 'node:assert/strict';
import test from 'node:test';

import { buildResumeHealthCheckModel } from './resumeHealthCheckModel.js';

test('missing resume recommends onboarding first', () => {
  const result = buildResumeHealthCheckModel({
    resumeExists: false,
    batchSummary: null,
    draftState: { status: 'idle' },
    draftExists: false,
  });

  assert.equal(result.primaryAction.kind, 'generate_record');
  assert.equal(result.resume.status, 'missing');
});

test('existing resume without batch recommends generating record', () => {
  const result = buildResumeHealthCheckModel({
    resumeExists: true,
    batchSummary: null,
    draftState: { status: 'idle' },
    draftExists: false,
  });

  assert.equal(result.primaryAction.kind, 'generate_record');
  assert.equal(result.batch.status, 'missing');
});

test('ready draft recommends chat refinement', () => {
  const result = buildResumeHealthCheckModel({
    resumeExists: true,
    batchSummary: { candidateGeneration: { message: '새 후보 2개' } },
    draftState: { status: 'completed' },
    draftExists: true,
  });

  assert.equal(result.primaryAction.kind, 'open_chat');
  assert.equal(result.draft.status, 'ready');
  assert.ok(result.chatExamples.length >= 3);
});

test('missing resume with batch data still centers worklog meaning before resume setup', () => {
  const result = buildResumeHealthCheckModel({
    resumeExists: false,
    batchSummary: { candidateGeneration: { message: '최근 기록 정리 완료' } },
    draftState: { status: 'idle' },
    draftExists: false,
  });

  assert.equal(result.primaryAction.kind, 'open_worklog');
  assert.equal(result.secondaryActions.some((action) => action.kind === 'open_resume'), true);
});

test('failed draft keeps chat as retry path', () => {
  const result = buildResumeHealthCheckModel({
    resumeExists: true,
    batchSummary: { candidateGeneration: { message: '새 후보 없음' } },
    draftState: { status: 'failed', error: 'timeout' },
    draftExists: false,
  });

  assert.equal(result.draft.status, 'failed');
  assert.equal(result.primaryAction.kind, 'open_worklog');
});
