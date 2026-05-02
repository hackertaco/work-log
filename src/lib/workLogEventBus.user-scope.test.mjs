import assert from 'node:assert/strict';
import test from 'node:test';

import {
  _clearGranularTriggers,
  _getPendingSources,
  emitCommitCollected,
  registerGranularTriggers,
} from './workLogEventBus.mjs';

test('granular triggers keep pending sources scoped by user id', async () => {
  _clearGranularTriggers();
  registerGranularTriggers(async () => {}, { debounceMs: 5000 });
  emitCommitCollected('2026-04-30', [], 'alice');
  emitCommitCollected('2026-04-30', [], 'bob');

  assert.ok(_getPendingSources('2026-04-30', 'alice'));
  assert.ok(_getPendingSources('2026-04-30', 'bob'));
  assert.notEqual(_getPendingSources('2026-04-30', 'alice'), _getPendingSources('2026-04-30', 'bob'));

  _clearGranularTriggers();
});
