/**
 * Tests for useDraftContext hook
 *
 * Uses Node.js built-in test runner — no external dependencies.
 * Source-level contract tests that verify the hook's exports,
 * state transitions, and API interaction patterns.
 *
 * Run: node --test frontend/src/hooks/useDraftContext.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const hookSource = readFileSync(resolve(__dirname, 'useDraftContext.js'), 'utf-8');

// ─── Source-level contract tests ─────────────────────────────────────────────

describe('useDraftContext — source contract', () => {
  test('exports useDraftContext as a named export', () => {
    assert.ok(
      hookSource.includes('export function useDraftContext'),
      'should export useDraftContext function'
    );
  });

  test('imports navigate for auth redirect', () => {
    assert.ok(
      hookSource.includes("import { navigate } from '../App.jsx'"),
      'should import navigate from App'
    );
  });

  test('uses Preact hooks for state management', () => {
    assert.ok(hookSource.includes('useState'), 'should use useState');
    assert.ok(hookSource.includes('useEffect'), 'should use useEffect');
    assert.ok(hookSource.includes('useCallback'), 'should use useCallback');
    assert.ok(hookSource.includes('useRef'), 'should use useRef');
  });
});

describe('useDraftContext — status transitions', () => {
  test('initializes with idle status', () => {
    assert.ok(
      hookSource.includes("useState('idle')"),
      'should initialize status as idle'
    );
  });

  test('transitions to loading when fetching cached draft', () => {
    assert.ok(
      hookSource.includes("setStatus('loading')"),
      'should set status to loading'
    );
  });

  test('transitions to generating when creating new draft', () => {
    assert.ok(
      hookSource.includes("setStatus('generating')"),
      'should set status to generating'
    );
  });

  test('transitions to ready on success', () => {
    assert.ok(
      hookSource.includes("setStatus('ready')"),
      'should set status to ready'
    );
  });

  test('transitions to error on failure', () => {
    assert.ok(
      hookSource.includes("setStatus('error')"),
      'should set status to error'
    );
  });
});

describe('useDraftContext — API interactions', () => {
  test('fetches cached draft via GET /api/resume/chat/generate-draft', () => {
    assert.ok(
      hookSource.includes("fetch('/api/resume/chat/generate-draft'"),
      'should GET the generate-draft endpoint'
    );
  });

  test('generates new draft via POST /api/resume/chat/generate-draft', () => {
    assert.ok(
      hookSource.includes("method: 'POST'"),
      'should use POST method for generation'
    );
  });

  test('handles 404 as cache miss (not error)', () => {
    assert.ok(
      hookSource.includes('res.status === 404'),
      'should check for 404 status'
    );
    assert.ok(
      hookSource.includes('cached: false'),
      'should return cached: false on 404'
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

  test('supports force regeneration', () => {
    assert.ok(
      hookSource.includes('force: true'),
      'should support force flag for regeneration'
    );
  });

  test('supports date range parameters', () => {
    assert.ok(
      hookSource.includes('fromDate') && hookSource.includes('toDate'),
      'should accept fromDate and toDate options'
    );
    assert.ok(
      hookSource.includes('from_date') && hookSource.includes('to_date'),
      'should send from_date and to_date in request body'
    );
  });
});

describe('useDraftContext — lifecycle management', () => {
  test('prevents duplicate initialization with ref guard', () => {
    assert.ok(
      hookSource.includes('initializedRef'),
      'should use initializedRef to prevent duplicate calls'
    );
  });

  test('prevents state updates after unmount', () => {
    assert.ok(
      hookSource.includes('mountedRef'),
      'should use mountedRef for unmount guard'
    );
    assert.ok(
      hookSource.includes('mountedRef.current = false'),
      'should set mountedRef to false on cleanup'
    );
  });

  test('auto-loads on mount via useEffect', () => {
    assert.ok(
      hookSource.includes('loadAndGenerate'),
      'should call loadAndGenerate on mount'
    );
  });

  test('skips generation when autoGenerate is false', () => {
    assert.ok(
      hookSource.includes('autoGenerate') && hookSource.includes('if (!autoGenerate)'),
      'should respect autoGenerate flag'
    );
  });
});

describe('useDraftContext — return value', () => {
  test('returns all expected state properties', () => {
    const returnBlock = hookSource.slice(hookSource.lastIndexOf('return {'));
    const expectedKeys = [
      'draft',
      'status',
      'loading',
      'generating',
      'error',
      'reload',
      'generate',
      'clearError',
    ];

    for (const key of expectedKeys) {
      assert.ok(
        returnBlock.includes(key),
        `return object should include "${key}"`
      );
    }
  });

  test('loading is derived from status', () => {
    assert.ok(
      hookSource.includes("loading: status === 'loading'"),
      'loading should be derived boolean from status'
    );
  });

  test('generating is derived from status', () => {
    assert.ok(
      hookSource.includes("generating: status === 'generating'"),
      'generating should be derived boolean from status'
    );
  });

  test('clearError resets error state', () => {
    assert.ok(
      hookSource.includes('setError(null)'),
      'clearError should set error to null'
    );
  });
});

describe('useDraftContext — loadAndGenerate pipeline', () => {
  test('pipeline: step 1 - fetches cached draft first', () => {
    // loadAndGenerate should call fetchCachedDraft first
    const loadFn = hookSource.slice(
      hookSource.indexOf('const loadAndGenerate'),
      hookSource.indexOf('const reload')
    );
    assert.ok(
      loadFn.includes('fetchCachedDraft'),
      'loadAndGenerate should call fetchCachedDraft'
    );
  });

  test('pipeline: step 2 - returns early if cached draft found', () => {
    assert.ok(
      hookSource.includes('if (cached.draft)'),
      'should check for cached draft and return early'
    );
  });

  test('pipeline: step 3 - generates if no cache and autoGenerate', () => {
    const loadFn = hookSource.slice(
      hookSource.indexOf('const loadAndGenerate'),
      hookSource.indexOf('const reload')
    );
    assert.ok(
      loadFn.includes('requestAsyncGeneration'),
      'loadAndGenerate should call requestAsyncGeneration when no cache (Sub-AC 2-3)'
    );
  });
});

describe('useDraftContext — async background generation (Sub-AC 2-3)', () => {
  test('sends async=true in POST body for background generation', () => {
    assert.ok(
      hookSource.includes('async: true'),
      'should send async: true in request body'
    );
  });

  test('handles 202 Accepted response (background task started)', () => {
    assert.ok(
      hookSource.includes('res.status === 202'),
      'should check for 202 Accepted status'
    );
  });

  test('handles 409 Conflict response (already in progress)', () => {
    assert.ok(
      hookSource.includes('res.status === 409'),
      'should check for 409 Conflict status'
    );
  });

  test('polls status endpoint for background generation progress', () => {
    assert.ok(
      hookSource.includes('/api/resume/chat/generate-draft/status'),
      'should poll the status endpoint'
    );
  });

  test('resets server-side state after completion', () => {
    assert.ok(
      hookSource.includes('/api/resume/chat/generate-draft/reset'),
      'should reset server-side state after completion or failure'
    );
  });

  test('returns progress and taskId in hook output', () => {
    const returnBlock = hookSource.slice(hookSource.lastIndexOf('return {'));
    assert.ok(returnBlock.includes('progress'), 'return object should include progress');
    assert.ok(returnBlock.includes('taskId'), 'return object should include taskId');
  });

  test('stops polling on unmount', () => {
    assert.ok(
      hookSource.includes('_stopPolling'),
      'should have _stopPolling function for cleanup'
    );
    assert.ok(
      hookSource.includes('pollTimerRef'),
      'should use pollTimerRef for interval management'
    );
  });

  test('uses configurable poll interval', () => {
    assert.ok(
      hookSource.includes('pollInterval'),
      'should accept pollInterval option'
    );
    assert.ok(
      hookSource.includes('DEFAULT_POLL_INTERVAL'),
      'should have a default poll interval'
    );
  });
});
