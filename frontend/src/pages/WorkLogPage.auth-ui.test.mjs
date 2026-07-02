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

test('WorkLogPage defines the handleAuthFailure helper its fetch paths call', () => {
  // Regression: 7d33ce7 added handleAuthFailure() call sites without a definition,
  // crashing every data fetch with a ReferenceError shown in the UI.
  assert.ok(source.includes('function handleAuthFailure('), 'handleAuthFailure must be defined');
  assert.ok(source.includes('handleAuthFailure(daysRes)'), 'bootstrap must guard 401/403 responses');
  assert.ok(
    source.includes("window.location.href = '/login'"),
    'auth failure must redirect to /login'
  );
});
