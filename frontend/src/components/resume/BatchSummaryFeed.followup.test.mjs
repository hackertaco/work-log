import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(__dirname, 'BatchSummaryFeed.jsx'), 'utf-8');

describe('BatchSummaryFeed — missing_metric follow-up', () => {
  test('renders a follow-up card when lastAction.followUp exists', () => {
    assert.ok(
      source.includes('summary?.candidateGeneration?.lastAction?.followUp'),
      'should read follow-up data from the latest candidate action'
    );
    assert.ok(
      source.includes('추가로 확인할 것') || source.includes('Meaning follow-up') || source.includes('Missing metric follow-up'),
      'should label the follow-up panel for missing metric recovery'
    );
  });

  test('shows follow-up questions and recovery actions', () => {
    assert.ok(
      source.includes('followUp.questions'),
      'should render follow-up questions'
    );
    assert.ok(
      source.includes('followUp.actions'),
      'should render follow-up action links'
    );
    assert.ok(
      source.includes('채팅에서 수치 정리하기') || source.includes('이력서 채팅 열기') || source.includes('Meaning Chat 열기') || source.includes('채팅으로 이어서 정리하기'),
      'should include a chat-oriented recovery CTA'
    );
  });
});
