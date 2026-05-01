import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { buildFeedbackBatchComment, postFeedbackBatch } from '../extensions/squad-reviews/lib/feedback-batch.mjs';
import { mockFetch, resetMocks } from './helpers.mjs';

const repoRoot = new URL('./fixtures/issue-review/', import.meta.url).pathname;

afterEach(() => {
  resetMocks();
});

describe('feedback-batch.mjs', () => {
  it('builds a consolidated batch comment with commit and thread summaries', () => {
    const body = buildFeedbackBatchComment({
      sha: 'abc1234',
      summary: 'Addressed security and docs feedback in one pass.',
      threads: [
        { threadId: 'PRRT_1', path: 'src/auth.ts', line: 42, action: 'addressed', summary: 'Added null guard.' },
        { commentId: '102', action: 'dismissed', summary: 'Explained existing invariant.' },
      ],
    });

    assert.match(body, /<!-- squad-feedback-batch -->/);
    assert.match(body, /Commit: `abc1234`/);
    assert.match(body, /Addressed security and docs feedback/);
    assert.match(body, /PRRT_1 \(src\/auth\.ts:L42\): Added null guard/);
    assert.match(body, /102: Explained existing invariant/);
    assert.match(body, /one implementation pass, one validation run, and one feedback-fix commit/);
  });

  it('posts one consolidated PR comment when no prior batch comment exists', async () => {
    const spy = mockFetch([
      {
        match: /\/repos\/acme\/rocket\/issues\/42\/comments\?per_page=100/,
        json: [],
      },
      {
        match: ({ url, init }) => /\/repos\/acme\/rocket\/issues\/42\/comments$/.test(url) && init.method === 'POST',
        status: 201,
        json: { id: 9001 },
      },
    ]);

    const result = await postFeedbackBatch(repoRoot, 'ghs_test_token', {
      pr: 42,
      owner: 'acme',
      repo: 'rocket',
      sha: 'abc1234',
      summary: 'Fixed all actionable review feedback.',
    });

    assert.deepEqual(result, {
      commentId: 9001,
      updated: false,
      marker: '<!-- squad-feedback-batch -->',
      instruction: 'Use this consolidated comment as the batch summary, then resolve individual review threads with concise replies that reference the same commit SHA.',
    });
    assert.equal(spy.calls.length, 2);
  });

  it('updates the existing consolidated PR comment instead of posting noisy duplicates', async () => {
    const spy = mockFetch([
      {
        match: /\/repos\/acme\/rocket\/issues\/42\/comments\?per_page=100/,
        json: [
          { id: 8001, body: '<!-- squad-feedback-batch -->\nold summary' },
          { id: 8002, body: 'unrelated comment' },
        ],
      },
      {
        match: ({ url, init }) => /\/repos\/acme\/rocket\/issues\/comments\/8001$/.test(url) && init.method === 'PATCH',
        json: { id: 8001 },
      },
    ]);

    const result = await postFeedbackBatch(repoRoot, 'ghs_test_token', {
      pr: 42,
      owner: 'acme',
      repo: 'rocket',
      sha: 'def5678',
      summary: 'Updated feedback batch after validation.',
    });

    assert.equal(result.commentId, 8001);
    assert.equal(result.updated, true);
    assert.equal(spy.calls.length, 2);
    assert.match(JSON.parse(spy.calls[1].init.body).body, /def5678/);
  });
});
