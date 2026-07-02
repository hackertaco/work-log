import assert from 'node:assert/strict';
import test from 'node:test';

import { collectSlackContexts } from './slack.mjs';

test('collectSlackContexts prefers config-provided slack credentials and channels', async () => {
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('auth.test')) {
      return new Response(JSON.stringify({ ok: true, user_id: 'U999' }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, messages: [] }), { status: 200 });
  };

  try {
    await collectSlackContexts({
      slackToken: 'config-token',
      slackUserId: 'U123',
      slackChannelIds: ['C111', 'C222'],
    }, '2026-05-02');
  } finally {
    global.fetch = originalFetch;
  }

  assert.ok(calls.some((url) => url.includes('auth.test')));
  assert.ok(calls.some((url) => url.includes('channel=C111')));
  assert.ok(calls.some((url) => url.includes('channel=C222')));
});
