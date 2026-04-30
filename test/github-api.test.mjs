import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

import {
  fetchPrDiff,
  fetchPrThreads,
  postReview,
  postComment,
  replyToThread,
  resolveThread,
} from '../extensions/squad-reviews/lib/github-api.mjs';
import { fixturePath, mockFetch, resetMocks } from './helpers.mjs';

const sampleDiff = readFileSync(fixturePath('sample-diff.txt'), 'utf8');

function parseJsonBody(call) {
  return JSON.parse(call.init.body ?? '{}');
}

afterEach(() => {
  resetMocks();
});

describe('github-api.mjs', () => {
  it('fetchPrDiff returns diff text', async () => {
    const spy = mockFetch([
      {
        match: /\/repos\/acme\/rocket\/pulls\/42$/,
        text: sampleDiff,
        headers: { 'content-type': 'text/plain' },
      },
    ]);

    const diff = await fetchPrDiff('ghs_test_token', 'acme', 'rocket', 42);

    assert.equal(diff, sampleDiff);
    assert.match(spy.calls[0].url, /\/repos\/acme\/rocket\/pulls\/42$/);
    assert.equal(spy.calls[0].init.headers.Accept, 'application/vnd.github.diff');
  });

  it('fetchPrThreads maps response to thread structure', async () => {
    mockFetch([
      {
        match: /\/repos\/acme\/rocket\/pulls\/42\/comments\?per_page=100/,
        json: [
          {
            id: 101,
            node_id: 'PRRC_node_101',
            body: 'Please rename this variable.',
            path: 'src/app.mjs',
            line: 12,
            user: { login: 'review-bot' },
            in_reply_to_id: null,
          },
        ],
      },
      {
        match: /https:\/\/api\.github\.com\/graphql/,
        json: {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: [
                    {
                      id: 'PRRT_123',
                      isResolved: false,
                      comments: {
                        nodes: [
                          {
                            id: 'PRRC_node_101',
                            databaseId: 101,
                          },
                        ],
                      },
                    },
                  ],
                  pageInfo: {
                    hasNextPage: false,
                    endCursor: null,
                  },
                },
              },
            },
          },
        },
      },
    ]);

    const threads = await fetchPrThreads('ghs_test_token', 'acme', 'rocket', 42);

    assert.deepEqual(threads, [
      {
        threadId: 'PRRT_123',
        commentId: 101,
        author: 'review-bot',
        body: 'Please rename this variable.',
        path: 'src/app.mjs',
        line: 12,
        isResolved: false,
      },
    ]);
  });

  it('postReview sends correct payload and returns ID', async () => {
    const spy = mockFetch([
      {
        match: /\/repos\/acme\/rocket\/pulls\/42\/reviews$/,
        status: 200,
        json: { id: 987 },
      },
    ]);

    const reviewId = await postReview('ghs_test_token', 'acme', 'rocket', 42, 'Looks good to me.', 'COMMENT');

    assert.equal(reviewId, 987);
    assert.equal(spy.calls[0].init.method, 'POST');
    assert.deepEqual(parseJsonBody(spy.calls[0]), {
      body: 'Looks good to me.',
      event: 'COMMENT',
    });
  });

  it('postComment posts to issues endpoint', async () => {
    const spy = mockFetch([
      {
        match: /\/repos\/acme\/rocket\/issues\/7\/comments$/,
        status: 201,
        json: { id: 654 },
      },
    ]);

    const commentId = await postComment('ghs_test_token', 'acme', 'rocket', 7, 'Issue feedback from the squad reviewer.');

    assert.equal(commentId, 654);
    assert.match(spy.calls[0].url, /\/repos\/acme\/rocket\/issues\/7\/comments$/);
    assert.equal(spy.calls[0].init.method, 'POST');
    assert.deepEqual(parseJsonBody(spy.calls[0]), {
      body: 'Issue feedback from the squad reviewer.',
    });
  });

  it('replyToThread posts reply correctly', async () => {
    const spy = mockFetch([
      {
        match: /\/repos\/acme\/rocket\/pulls\/42\/comments\/101\/replies$/,
        status: 201,
        json: { id: 4321 },
      },
    ]);

    const replyId = await replyToThread(
      'ghs_test_token',
      'acme',
      'rocket',
      42,
      101,
      'Thanks, fixed in the latest commit.',
    );

    assert.equal(replyId, 4321);
    assert.equal(spy.calls[0].init.method, 'POST');
    assert.deepEqual(parseJsonBody(spy.calls[0]), {
      body: 'Thanks, fixed in the latest commit.',
    });
  });

  it('resolveThread sends GraphQL mutation', async () => {
    const spy = mockFetch([
      {
        match: /https:\/\/api\.github\.com\/graphql/,
        status: 200,
        json: {
          data: {
            resolveReviewThread: {
              thread: {
                isResolved: true,
              },
            },
          },
        },
      },
    ]);

    await resolveThread('ghs_test_token', 'PRRT_123');

    assert.equal(spy.calls[0].init.method, 'POST');
    const payload = parseJsonBody(spy.calls[0]);
    assert.match(payload.query, /resolveReviewThread/i);
    assert.equal(payload.variables.threadId, 'PRRT_123');
  });

  it('all functions throw on non-2xx response', async () => {
    const errorResponse = [{ match: /api\.github\.com/, status: 500, text: 'boom' }];

    mockFetch(errorResponse);
    await assert.rejects(() => fetchPrDiff('ghs_test_token', 'acme', 'rocket', 42), /500|boom/);

    mockFetch(errorResponse);
    await assert.rejects(() => fetchPrThreads('ghs_test_token', 'acme', 'rocket', 42), /500|boom/);

    mockFetch(errorResponse);
    await assert.rejects(
      () => postReview('ghs_test_token', 'acme', 'rocket', 42, 'body', 'COMMENT'),
      /500|boom/,
    );

    mockFetch(errorResponse);
    await assert.rejects(() => postComment('ghs_test_token', 'acme', 'rocket', 7, 'body'), /500|boom/);

    mockFetch(errorResponse);
    await assert.rejects(() => replyToThread('ghs_test_token', 'acme', 'rocket', 42, 101, 'body'), /500|boom/);

    mockFetch(errorResponse);
    await assert.rejects(() => resolveThread('ghs_test_token', 'PRRT_123'), /500|boom/);
  });
});
