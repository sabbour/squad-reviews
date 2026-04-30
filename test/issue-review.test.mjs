import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { executeIssueReview } from '../extensions/squad-reviews/lib/issue-review.mjs';
import { mockFetch, resetMocks, COMPLIANT_REVIEW_BODY } from './helpers.mjs';

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
      reviewBody: COMPLIANT_REVIEW_BODY,
      approved: false,
      owner: 'acme',
      repo: 'rocket',
    });

    assert.equal(result.posted, true);
    assert.equal(result.commentId, 701);
    assert.equal(result.labelApplied, null);
    assert.equal(result.reviewer, 'zapp');
    assert.equal(result.issue, 7);
    assert.ok(result.quality);
    assert.equal(spy.calls.length, 1);
    assert.equal(JSON.parse(spy.calls[0].init.body).body, COMPLIANT_REVIEW_BODY);
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
      reviewBody: COMPLIANT_REVIEW_BODY,
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
      reviewBody: COMPLIANT_REVIEW_BODY,
      approved: false,
      owner: 'acme',
      repo: 'rocket',
    });

    assert.equal(result.labelApplied, null);
    assert.equal(spy.calls.length, 1);
  });
});
