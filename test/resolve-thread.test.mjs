import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { resolveReviewThread, resolveThread } from '../extensions/squad-reviews/lib/resolve-thread.mjs';
import { mockFetch, resetMocks } from './helpers.mjs';

const repoRoot = new URL('./fixtures/issue-review/', import.meta.url).pathname;

afterEach(() => {
  resetMocks();

});

describe('resolve-thread.mjs', () => {
  it('replies then resolves (happy path)', async () => {
    const spy = mockFetch([
      {
        match: /https:\/\/api\.github\.com\/graphql/,
        status: 200,
        json: {
          data: {
            resolveReviewThread: {
              thread: { isResolved: true },
            },
          },
        },
      },
    ]);

    const result = await resolveThread(repoRoot, 'ghs_test_token', {
      pr: 42,
      threadId: 'PRRT_123',
      commentId: 101,
      reply: { sha: 'abc1234', description: 'Renamed the variable and added coverage.' },
      action: 'addressed',
      owner: 'acme',
      repo: 'rocket',
    });

    assert.equal(result.resolved, true);
    assert.equal(result.replyId, null);
    assert.equal(result.action, 'addressed');
    assert.equal(result.closureRule.reviewDecision, null);
    assert.equal(spy.calls.length, 2);
    assert.ok(spy.calls.every((call) => /graphql/.test(call.url)),
      'no /replies endpoint should be called for action=addressed');
  });

  it('does NOT call replyToThread when action is addressed', async () => {
    let replyToThreadCalled = false;
    let resolveThreadCalled = false;

    const result = await resolveReviewThread({
      token: 'ghs_test_token',
      owner: 'acme',
      repo: 'rocket',
      pr: 42,
      threadId: 'PRRT_123',
      commentId: 101,
      action: 'addressed',
      config: {
        threadResolution: {
          templates: {
            addressed: 'Addressed in {sha}: {description}',
            dismissed: 'Dismissed: {justification}',
          },
        },
      },
    }, {
      replyToThread: async () => { replyToThreadCalled = true; return 9999; },
      resolveThread: async () => { resolveThreadCalled = true; },
      getClosureStatus: async () => ({ unresolvedThreads: 0, reviewDecision: 'APPROVED', changeRequestReviewers: [] }),
      sleep: async () => {},
    });

    assert.equal(replyToThreadCalled, false, 'replyToThread must NOT be called for action=addressed');
    assert.equal(resolveThreadCalled, true, 'resolveThread must be called');
    assert.equal(result.replyId, null);
    assert.equal(result.resolved, true);
  });

  it('fails closed if reply fails (no resolve attempted)', async () => {
    const spy = mockFetch([
      {
        match: /\/replies$/,
        status: 500,
        text: 'reply failed',
      },
      {
        match: /https:\/\/api\.github\.com\/graphql/,
        status: 200,
        json: {
          data: {
            resolveReviewThread: {
              thread: { isResolved: true },
            },
          },
        },
      },
    ]);

    await assert.rejects(
      () =>
        resolveThread(repoRoot, 'ghs_test_token', {
          pr: 42,
          threadId: 'PRRT_123',
          commentId: 101,
          reply: { justification: 'Not actionable in this PR.' },
          action: 'dismissed',
          owner: 'acme',
          repo: 'rocket',
        }),
      /reply failed|500/,
    );

    assert.equal(spy.calls.length, 1);
    assert.doesNotMatch(spy.calls[0].url, /graphql/);
  });

  it('retries resolve if resolve failed (no reply for addressed)', async () => {
    let graphqlAttempts = 0;
    const spy = mockFetch([
      {
        match: (request) => /https:\/\/api\.github\.com\/graphql/.test(request.url) && graphqlAttempts++ === 0,
        status: 500,
        text: 'transient GraphQL failure',
      },
      {
        match: /https:\/\/api\.github\.com\/graphql/,
        status: 200,
        json: {
          data: {
            resolveReviewThread: {
              thread: { isResolved: true },
            },
          },
        },
      },
    ]);

    const result = await resolveThread(repoRoot, 'ghs_test_token', {
      pr: 42,
      threadId: 'PRRT_123',
      commentId: 101,
      reply: { sha: 'abc1234', description: 'Added the missing null check.' },
      action: 'addressed',
      owner: 'acme',
      repo: 'rocket',
    });

    assert.equal(result.resolved, true);
    assert.equal(spy.calls.filter((call) => /graphql/.test(call.url)).length, 3);
    assert.equal(spy.calls.filter((call) => /\/replies$/.test(call.url)).length, 0);
  });

  it('uses correct template for "dismissed" action', async () => {
    const spy = mockFetch([
      {
        match: /\/replies$/,
        status: 201,
        json: { id: 1001 },
      },
      {
        match: /https:\/\/api\.github\.com\/graphql/,
        status: 200,
        json: {
          data: {
            resolveReviewThread: {
              thread: { isResolved: true },
            },
          },
        },
      },
    ]);

    await resolveThread(repoRoot, 'ghs_test_token', {
      pr: 42,
      threadId: 'PRRT_123',
      commentId: 101,
      reply: { justification: 'The warning is outside this change scope.' },
      action: 'dismissed',
      owner: 'acme',
      repo: 'rocket',
    });

    assert.equal(
      JSON.parse(spy.calls[0].init.body).body,
      'Dismissed: The warning is outside this change scope.',
    );
  });

  it('returns two-step closure instructions when reviewDecision is still CHANGES_REQUESTED after all threads resolve', async () => {
    mockFetch([
      {
        match: ({ url, init }) => /https:\/\/api\.github\.com\/graphql/.test(url)
          && JSON.parse(init.body).query.includes('resolveReviewThread'),
        status: 200,
        json: {
          data: {
            resolveReviewThread: {
              thread: { isResolved: true },
            },
          },
        },
      },
      {
        match: ({ url, init }) => /https:\/\/api\.github\.com\/graphql/.test(url)
          && JSON.parse(init.body).query.includes('reviewDecision'),
        status: 200,
        json: {
          data: {
            repository: {
              pullRequest: {
                reviewDecision: 'CHANGES_REQUESTED',
                reviews: {
                  nodes: [
                    { state: 'CHANGES_REQUESTED', author: { login: 'octocat' } },
                    { state: 'CHANGES_REQUESTED', author: { login: 'squad-codereview[bot]' } },
                  ],
                },
                reviewThreads: {
                  nodes: [
                    { isResolved: true },
                    { isResolved: true },
                  ],
                },
              },
            },
          },
        },
      },
    ]);

    const result = await resolveThread(repoRoot, 'ghs_test_token', {
      pr: 42,
      threadId: 'PRRT_123',
      commentId: 101,
      reply: { sha: 'abc1234', description: 'Fixed the failing path.' },
      action: 'addressed',
      owner: 'acme',
      repo: 'rocket',
    });

    assert.equal(result.closureRule.allThreadsResolved, true);
    assert.equal(result.closureRule.reviewDecision, 'CHANGES_REQUESTED');
    assert.equal(result.closureRule.humanReReviewRequired, true);
    assert.deepEqual(result.closureRule.humanReviewersNeedingReReview, ['octocat']);
    assert.equal(result.closureRule.roleGateApprovalRequired, true);
    assert.match(result.closureRule.instruction, /squad_reviews_execute_pr_review/);
  });

});
