import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(__dirname, 'ResumeShell.jsx'), 'utf8');

test('ResumeShell shows current authenticated user badge', () => {
  assert.ok(source.includes('사용자 · {userId}'));
});

test('ResumeShell exposes logout action', () => {
  assert.ok(source.includes('logout(\'/login\')'));
  assert.ok(source.includes('로그아웃'));
});
