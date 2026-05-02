import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(__dirname, 'WorkLogPage.jsx'), 'utf8');

test('WorkLogPage renders current user badge when authenticated', () => {
  assert.ok(source.includes('사용자 · {userId}'));
});

test('WorkLogPage exposes logout action from the worklog header', () => {
  assert.ok(source.includes('logout(\'/login\')'));
  assert.ok(source.includes('worklog-user-logout'));
});
