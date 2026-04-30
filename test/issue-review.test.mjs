import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { executeIssueReview } from '../extensions/squad-reviews/lib/issue-review.mjs';
import { mockFetch, resetMocks } from './helpers.mjs';

const repoRoot = new URL('./fixtures/issue-review/', import.meta.url).pathname;

afterEach(() => {
  resetMocks();
});

describe('issue-review.mjs', () => {
  it('posts comment on issue', async () => {
    const spy = mockFetch([
      {
        match: /\/repos\/acme\/rocket\/issues\/7\/comments$/,
        status: 201,
        json: { id: 701 },
      },
    ]);

    const result = await executeIssueReview(repoRoot, 'ghs_test_token', {
      issue: 7,
      roleSlug: 'security',
      reviewBody: 'Security review feedback.',
      approved: false,
      owner: 'acme',
      repo: 'rocket',
    });

    assert.deepEqual(result, {
      posted: true,
      commentId: 701,
      labelApplied: null,
      reviewer: 'zapp',
      issue: 7,
    });
    assert.equal(spy.calls.length, 1);
    assert.equal(JSON.parse(spy.calls[0].init.body).body, 'Security review feedback.');
  });

  it('applies label when approved', async () => {
    const spy = mockFetch([
      {
        match: /\/repos\/acme\/rocket\/issues\/7\/comments$/,
        status: 201,
        json: { id: 702 },
      },
      {
        match: /\/repos\/acme\/rocket\/issues\/7\/labels$/,
        status: 200,
        json: [{ name: 'security:approved' }],
      },
    ]);

    const result = await executeIssueReview(repoRoot, 'ghs_test_token', {
      issue: 7,
      roleSlug: 'security',
      reviewBody: 'Approved from a security perspective.',
      approved: true,
      owner: 'acme',
      repo: 'rocket',
    });

    assert.equal(result.labelApplied, 'security:approved');
    assert.equal(spy.calls.length, 2);
    assert.deepEqual(JSON.parse(spy.calls[1].init.body), {
      labels: ['security:approved'],
    });
  });

  it('does not apply label when not approved', async () => {
    const spy = mockFetch([
      {
        match: /\/repos\/acme\/rocket\/issues\/7\/comments$/,
        status: 201,
        json: { id: 703 },
      },
    ]);

    const result = await executeIssueReview(repoRoot, 'ghs_test_token', {
      issue: 7,
      roleSlug: 'security',
      reviewBody: 'Not approved yet.',
      approved: false,
      owner: 'acme',
      repo: 'rocket',
    });

    assert.equal(result.labelApplied, null);
    assert.equal(spy.calls.length, 1);
  });
});
