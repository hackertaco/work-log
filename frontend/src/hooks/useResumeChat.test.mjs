/**
 * Tests for useResumeChat hook
 *
 * Uses Node.js built-in test runner — no external dependencies.
 * These are structural/contract tests that verify the hook's exports
 * and logic without a full Preact rendering environment.
 *
 * Run: node --test frontend/src/hooks/useResumeChat.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const hookSource = readFileSync(resolve(__dirname, 'useResumeChat.js'), 'utf-8');

// ─── Source-level contract tests ─────────────────────────────────────────────

describe('useResumeChat — source contract', () => {
  test('exports useResumeChat as a named export', () => {
    assert.ok(
      hookSource.includes('export function useResumeChat'),
      'should export useResumeChat function'
    );
  });

  test('imports useDraftContext for draft delegation', () => {
    assert.ok(
      hookSource.includes("from './useDraftContext.js'"),
      'should import useDraftContext'
    );
  });

  test('imports navigate for auth redirect', () => {
    assert.ok(
      hookSource.includes("import { navigate } from '../App.jsx'"),
      'should import navigate'
    );
  });

  test('creates a unique sessionId on initialization', () => {
    assert.ok(
      hookSource.includes('chat-${Date.now()}'),
      'should create session ID with timestamp'
    );
  });

  test('fetches initial resume on mount for diff baseline', () => {
    assert.ok(
      hookSource.includes("fetch('/api/resume'"),
      'should fetch /api/resume for initial snapshot'
    );
    assert.ok(
      hookSource.includes('setInitialResume'),
      'should set initialResume state'
    );
  });

  test('sends chat messages to POST /api/resume/chat', () => {
    assert.ok(
      hookSource.includes("fetch('/api/resume/chat'"),
      'should POST to /api/resume/chat'
    );
  });

  test('includes draftContext in chat API payload', () => {
    assert.ok(
      hookSource.includes('draftContext: draft'),
      'should include draft context in request body'
    );
    assert.ok(
      hookSource.includes('strengthCandidates'),
      'should forward strengthCandidates from draft'
    );
    assert.ok(
      hookSource.includes('experienceSummaries'),
      'should forward experienceSummaries from draft'
    );
  });

  test('handles auth redirect (401/403)', () => {
    assert.ok(
      hookSource.includes('res.status === 401'),
      'should check for 401 status'
    );
    assert.ok(
      hookSource.includes('res.status === 403'),
      'should check for 403 status'
    );
    assert.ok(
      hookSource.includes("navigate('/login')"),
      'should navigate to login on auth failure'
    );
  });

  test('returns all expected state properties', () => {
    // Verify return object properties
    const returnBlock = hookSource.slice(hookSource.lastIndexOf('return {'));
    const expectedKeys = [
      'draft',
      'insightDraft',
      'draftStatus',
      'draftError',
      'draftRetry',
      'messages',
      'setMessages',
      'sendMessage',
      'loading',
      'sessionId',
      'initialResume',
      'currentResume',
      'refreshResume',
      'approvedCount',
    ];

    for (const key of expectedKeys) {
      assert.ok(
        returnBlock.includes(key),
        `return object should include "${key}"`
      );
    }
  });

  test('manages loading state around sendMessage', () => {
    // setLoading(true) before fetch, setLoading(false) in finally
    assert.ok(
      hookSource.includes('setLoading(true)'),
      'should set loading to true before API call'
    );
    assert.ok(
      hookSource.includes('setLoading(false)'),
      'should set loading to false after API call'
    );
  });

  test('parses assistant message with diff, citations, and applyIntent', () => {
    assert.ok(
      hookSource.includes('data.diff'),
      'should parse diff from response'
    );
    assert.ok(
      hookSource.includes('data.rankedEvidence'),
      'should parse rankedEvidence as citations'
    );
    assert.ok(
      hookSource.includes('data.applyIntent'),
      'should parse applyIntent from response'
    );
  });

  test('creates error message on sendMessage failure', () => {
    assert.ok(
      hookSource.includes("role: 'assistant'") && hookSource.includes('error: true'),
      'should create error assistant message on failure'
    );
  });

  test('refreshResume increments approvedCount', () => {
    assert.ok(
      hookSource.includes('setApprovedCount((c) => c + 1)'),
      'should increment approvedCount on successful refresh'
    );
  });

  test('sends message history to API', () => {
    assert.ok(
      hookSource.includes('history: messages.map'),
      'should include message history in API request'
    );
  });

  test('prevents duplicate submissions while loading', () => {
    assert.ok(
      hookSource.includes('if (loading) return'),
      'should guard against duplicate submissions'
    );
  });
});

describe('useResumeChat — default options', () => {
  test('autoGenerateDraft defaults to true', () => {
    assert.ok(
      hookSource.includes('autoGenerateDraft = true'),
      'should default autoGenerateDraft to true'
    );
  });

  test('passes autoGenerateDraft to useDraftContext', () => {
    assert.ok(
      hookSource.includes('autoGenerate: autoGenerateDraft'),
      'should forward autoGenerateDraft to useDraftContext'
    );
  });
});
