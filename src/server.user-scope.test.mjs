import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from './server.mjs';
import { projectRoot } from './lib/utils.mjs';

const CONFIG_PATH = path.join(projectRoot, 'work-log.config.json');

async function withScopedFixture(fn) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'worklog-users-'));
  let configBackup = null;
  const envBackup = {
    WORK_LOG_USERS_JSON: process.env.WORK_LOG_USERS_JSON,
    RESUME_TOKEN: process.env.RESUME_TOKEN,
  };

  try {
    try {
      configBackup = await fs.readFile(CONFIG_PATH, 'utf8');
    } catch {}

    await fs.writeFile(CONFIG_PATH, JSON.stringify({ dataDir: tmpDir, vaultDir: path.join(tmpDir, 'vault') }, null, 2));
    process.env.WORK_LOG_USERS_JSON = JSON.stringify([
      { id: 'alice', token: 'alice-token' },
      { id: 'bob', token: 'bob-token' },
    ]);
    delete process.env.RESUME_TOKEN;

    await fs.mkdir(path.join(tmpDir, 'daily'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'users', 'alice', 'daily'), { recursive: true });

    await fs.writeFile(path.join(tmpDir, 'daily', '2026-04-01.json'), JSON.stringify({ date: '2026-04-01' }));
    await fs.writeFile(path.join(tmpDir, 'users', 'alice', 'daily', '2026-04-02.json'), JSON.stringify({ date: '2026-04-02' }));

    await fn(tmpDir);
  } finally {
    if (configBackup == null) {
      await fs.rm(CONFIG_PATH, { force: true });
    } else {
      await fs.writeFile(CONFIG_PATH, configBackup);
    }
    if (envBackup.WORK_LOG_USERS_JSON === undefined) delete process.env.WORK_LOG_USERS_JSON; else process.env.WORK_LOG_USERS_JSON = envBackup.WORK_LOG_USERS_JSON;
    if (envBackup.RESUME_TOKEN === undefined) delete process.env.RESUME_TOKEN; else process.env.RESUME_TOKEN = envBackup.RESUME_TOKEN;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

test('/api/days rejects unauthenticated requests', async () => {
  await withScopedFixture(async () => {
    const app = createApp();
    const res = await app.fetch(new Request('http://localhost/api/days'));
    assert.equal(res.status, 401);
  });
});

test('/api/days uses default workspace for the default auth token', async () => {
  await withScopedFixture(async () => {
    process.env.WORK_LOG_USERS_JSON = JSON.stringify([{ id: 'default', token: 'default-token' }, { id: 'alice', token: 'alice-token' }]);
    const app = createApp();
    const res = await app.fetch(new Request('http://localhost/api/days', {
      headers: { cookie: 'resume_token=default-token' },
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), ['2026-04-01']);
  });
});

test('/api/days uses user-scoped workspace when auth cookie maps to a user', async () => {
  await withScopedFixture(async () => {
    const app = createApp();
    const res = await app.fetch(new Request('http://localhost/api/days', {
      headers: { cookie: 'resume_token=alice-token' },
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), ['2026-04-02']);
  });
});
