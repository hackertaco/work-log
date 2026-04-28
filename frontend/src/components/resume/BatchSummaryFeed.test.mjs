import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(__dirname, 'BatchSummaryFeed.jsx'), 'utf-8');

describe('BatchSummaryFeed — chat handoff affordance', () => {
  test('renders a candidate-level refine-in-chat action', () => {
    assert.ok(
      source.includes('채팅으로 다듬기') || source.includes('더 깊게 보기'),
      'should expose a refine-in-chat CTA for each candidate'
    );
  });

  test('links the CTA to ResumeChatPage with a candidateId query param', () => {
    assert.ok(
      source.includes('/resume/chat?candidateId='),
      'should deep-link into the chat refinement flow'
    );
    assert.ok(
      source.includes('encodeURIComponent(item.id)'),
      'should safely encode candidate ids in the chat handoff URL'
    );
  });
});
