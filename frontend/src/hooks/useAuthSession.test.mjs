import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(__dirname, 'useAuthSession.js'), 'utf8');

test('useAuthSession reads /auth/me with credentials included', () => {
  assert.ok(source.includes("fetch('/auth/me', { credentials: 'include' })"));
});

test('useAuthSession exposes logout that calls /auth/logout', () => {
  assert.ok(source.includes("fetch('/auth/logout', { method: 'POST', credentials: 'include' })"));
  assert.ok(source.includes('window.location.href = nextPath'));
});
