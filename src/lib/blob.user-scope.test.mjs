import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RESUME_DATA_PATHNAME,
  CHAT_DRAFT_CONTEXT_PATHNAME,
  bulletsPathnameForDate,
  pathForUser,
  snapshotPathnameFor,
} from './blob.mjs';

test('pathForUser keeps default paths unchanged', () => {
  assert.equal(pathForUser(RESUME_DATA_PATHNAME), 'resume/data.json');
});

test('pathForUser scopes non-default user paths', () => {
  assert.equal(pathForUser(RESUME_DATA_PATHNAME, 'alice'), 'users/alice/resume/data.json');
  assert.equal(pathForUser(CHAT_DRAFT_CONTEXT_PATHNAME, 'bob kim'), 'users/bob-kim/resume/chat-draft-context.json');
});

test('bulletsPathnameForDate scopes per user', () => {
  assert.equal(bulletsPathnameForDate('2026-04-30'), 'resume/bullets/2026-04-30.json');
  assert.equal(bulletsPathnameForDate('2026-04-30', 'alice'), 'users/alice/resume/bullets/2026-04-30.json');
});

test('snapshotPathnameFor scopes per user', () => {
  assert.equal(snapshotPathnameFor('2026-04-30T10:00:00.000Z'), 'resume/snapshots/2026-04-30T10-00-00.000Z.json');
  assert.equal(snapshotPathnameFor('2026-04-30T10:00:00.000Z', 'alice'), 'users/alice/resume/snapshots/2026-04-30T10-00-00.000Z.json');
});
