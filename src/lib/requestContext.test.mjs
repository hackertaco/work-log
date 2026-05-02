import assert from 'node:assert/strict';
import test from 'node:test';

import { pathForUser } from './blob.mjs';
import { loadConfig } from './config.mjs';
import { runWithRequestContext, getCurrentUserId } from './requestContext.mjs';

test('request context exposes current user id', async () => {
  await runWithRequestContext({ userId: 'alice' }, async () => {
    assert.equal(getCurrentUserId(), 'alice');
  });
});

test('pathForUser uses current request user when userId is omitted', async () => {
  await runWithRequestContext({ userId: 'alice' }, async () => {
    assert.equal(pathForUser('resume/data.json'), 'users/alice/resume/data.json');
  });
});

test('loadConfig uses current request user when options.userId is omitted', async () => {
  await runWithRequestContext({ userId: 'alice' }, async () => {
    const config = await loadConfig();
    assert.ok(config.dataDir.endsWith('/data/users/alice'));
  });
});
