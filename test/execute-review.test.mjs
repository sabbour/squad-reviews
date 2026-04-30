import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

import { executePrReview } from '../extensions/squad-reviews/lib/execute-review.mjs';
import { fixturePath, mockFetch, resetMocks } from './helpers.mjs';

const repoRoot = new URL('./fixtures/review-repo/', import.meta.url).pathname;
const sampleDiff = readFileSync(fixturePath('sample-diff.txt'), 'utf8');

afterEach(() => {
  resetMocks();
});

describe('execute-review.mjs', () => {
  it('fetches diff and posts COMMENT review', async () => {
    const spy = mockFetch([
      {
        match: /\/repos\/acme\/rocket\/pulls\/42$/,
        text: sampleDiff,
      },
      {
        match: /\/repos\/acme\/rocket\/pulls\/42\/reviews$/,
        status: 200,
        json: { id: 501 },
      },
    ]);

    const result = await executePrReview(repoRoot, 'ghs_test_token', {
      pr: 42,
      roleSlug: 'core-dev',
      event: 'COMMENT',
      reviewBody: 'Non-blocking feedback.',
      owner: 'acme',
      repo: 'rocket',
    });

    assert.deepEqual(result, {
      posted: true,
      reviewId: '501',
      event: 'COMMENT',
      reviewer: 'poe',
    });
    assert.equal(spy.calls.length, 2);
    assert.equal(JSON.parse(spy.calls[1].init.body).event, 'COMMENT');
  });

  it('fetches diff and posts REQUEST_CHANGES review', async () => {
    const spy = mockFetch([
      {
        match: /\/repos\/acme\/rocket\/pulls\/42$/,
        text: sampleDiff,
      },
      {
        match: /\/repos\/acme\/rocket\/pulls\/42\/reviews$/,
        status: 200,
        json: { id: 502 },
      },
    ]);

    const result = await executePrReview(repoRoot, 'ghs_test_token', {
      pr: 42,
      roleSlug: 'core-dev',
      event: 'REQUEST_CHANGES',
      reviewBody: 'Blocking regression found.',
      owner: 'acme',
      repo: 'rocket',
    });

    assert.equal(result.reviewId, '502');
    assert.equal(JSON.parse(spy.calls[1].init.body).event, 'REQUEST_CHANGES');
  });

  it('reads charter from charterPath', async () => {
    mockFetch([
      {
        match: /\/repos\/acme\/rocket\/pulls\/42$/,
        text: sampleDiff,
      },
    ]);

    const result = await executePrReview(repoRoot, 'ghs_test_token', {
      pr: 42,
      roleSlug: 'core-dev',
      event: 'COMMENT',
      owner: 'acme',
      repo: 'rocket',
    });

    assert.equal(result.posted, false);
    assert.match(result.charter, /core correctness/i);
    assert.equal(result.diff, sampleDiff);
  });

  it('throws if token resolution fails', async () => {
    mockFetch([
      {
        match: /\/repos\/acme\/rocket\/pulls\/42$/,
        status: 401,
        text: 'Unauthorized',
      },
    ]);

    await assert.rejects(
      () =>
        executePrReview(repoRoot, '', {
          pr: 42,
          roleSlug: 'core-dev',
          event: 'COMMENT',
          owner: 'acme',
          repo: 'rocket',
        }),
      /401|Unauthorized|token/i,
    );
  });
});
