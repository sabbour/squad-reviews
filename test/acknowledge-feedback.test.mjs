import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { acknowledgeFeedback } from '../extensions/squad-reviews/lib/acknowledge-feedback.mjs';
import { createMockConfig, mockFetch, resetMocks } from './helpers.mjs';

const repoRoot = new URL('./fixtures/issue-review/', import.meta.url).pathname;
let workspaceCounter = 0;

async function createWorkspace(t, config) {
  const workspace = resolve(
    process.cwd(),
    'test',
    '.runtime',
    `acknowledge-feedback-${process.pid}-${Date.now()}-${workspaceCounter++}`,
  );

  await mkdir(resolve(workspace, '.squad', 'reviews'), { recursive: true });
  await writeFile(resolve(workspace, '.squad', 'reviews', 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  t.after(() => rm(workspace, { recursive: true, force: true }));
  return workspace;
}

afterEach(() => {
  resetMocks();
});

describe('acknowledge-feedback.mjs', () => {
  it('returns only unresolved threads', async () => {
    mockFetch([
      {
        match: /\/repos\/acme\/rocket\/pulls\/42\/comments\?per_page=100/,
        json: [
          {
            id: 101,
            node_id: 'PRRC_node_101',
            body: 'Please rename this.',
            path: 'src/app.mjs',
            line: 12,
            user: { login: 'octocat' },
            in_reply_to_id: null,
          },
          {
            id: 102,
            node_id: 'PRRC_node_102',
            body: 'Copilot note.',
            path: 'src/app.mjs',
            line: 14,
            user: { login: 'github-copilot[bot]' },
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
                      id: 'PRRT_1',
                      isResolved: false,
                      comments: { nodes: [{ id: 'PRRC_node_101', databaseId: 101 }] },
                    },
                    {
                      id: 'PRRT_2',
                      isResolved: true,
                      comments: { nodes: [{ id: 'PRRC_node_102', databaseId: 102 }] },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        },
      },
    ]);

    const result = await acknowledgeFeedback(repoRoot, 'ghs_test_token', {
      pr: 42,
      owner: 'acme',
      repo: 'rocket',
    });

    assert.deepEqual(result.unresolvedThreads.map((thread) => thread.threadId), ['PRRT_1']);
    assert.equal(result.totalUnresolved, 1);
    assert.match(result.instruction, /one implementation pass/i);
    assert.match(result.instruction, /one commit/i);
    assert.match(result.instruction, /reviewDecision/i);
    assert.equal(result.batchPlan.mode, 'batched-per-pr');
    assert.match(result.batchPlan.comment, /consolidated PR comment/i);
    assert.match(result.batchPlan.closure, /squad_reviews_execute_pr_review/i);
  });

  it('includes threads from all feedback sources', async () => {
    mockFetch([
      {
        match: /\/repos\/acme\/rocket\/pulls\/42\/comments\?per_page=100/,
        json: [
          {
            id: 101,
            node_id: 'PRRC_node_101',
            body: 'Human feedback.',
            path: 'src/app.mjs',
            line: 12,
            user: { login: 'octocat' },
            in_reply_to_id: null,
          },
          {
            id: 102,
            node_id: 'PRRC_node_102',
            body: 'Squad feedback.',
            path: 'src/app.mjs',
            line: 14,
            user: { login: 'zapp[bot]' },
            in_reply_to_id: null,
          },
          {
            id: 103,
            node_id: 'PRRC_node_103',
            body: 'Copilot feedback.',
            path: 'src/app.mjs',
            line: 16,
            user: { login: 'github-copilot[bot]' },
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
                    { id: 'PRRT_human', isResolved: false, comments: { nodes: [{ id: 'PRRC_node_101', databaseId: 101 }] } },
                    { id: 'PRRT_squad', isResolved: false, comments: { nodes: [{ id: 'PRRC_node_102', databaseId: 102 }] } },
                    { id: 'PRRT_copilot', isResolved: false, comments: { nodes: [{ id: 'PRRC_node_103', databaseId: 103 }] } },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        },
      },
    ]);

    const result = await acknowledgeFeedback(repoRoot, 'ghs_test_token', {
      pr: 42,
      owner: 'acme',
      repo: 'rocket',
    });

    assert.deepEqual(
      result.unresolvedThreads.map((thread) => thread.source).sort(),
      ['github-copilot-bot', 'humans', 'squad-agents'],
    );
  });

  it('filters by configured feedbackSources', async (t) => {
    const config = createMockConfig();
    config.reviewers = {
      security: config.reviewers.security,
    };
    config.feedbackSources = ['humans'];
    const workspace = await createWorkspace(t, config);

    mockFetch([
      {
        match: /\/repos\/acme\/rocket\/pulls\/42\/comments\?per_page=100/,
        json: [
          {
            id: 101,
            node_id: 'PRRC_node_101',
            body: 'Human feedback.',
            path: 'src/app.mjs',
            line: 12,
            user: { login: 'octocat' },
            in_reply_to_id: null,
          },
          {
            id: 102,
            node_id: 'PRRC_node_102',
            body: 'Squad feedback.',
            path: 'src/app.mjs',
            line: 14,
            user: { login: 'zapp[bot]' },
            in_reply_to_id: null,
          },
          {
            id: 103,
            node_id: 'PRRC_node_103',
            body: 'Copilot feedback.',
            path: 'src/app.mjs',
            line: 16,
            user: { login: 'github-copilot[bot]' },
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
                    { id: 'PRRT_human', isResolved: false, comments: { nodes: [{ id: 'PRRC_node_101', databaseId: 101 }] } },
                    { id: 'PRRT_squad', isResolved: false, comments: { nodes: [{ id: 'PRRC_node_102', databaseId: 102 }] } },
                    { id: 'PRRT_copilot', isResolved: false, comments: { nodes: [{ id: 'PRRC_node_103', databaseId: 103 }] } },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        },
      },
    ]);

    const result = await acknowledgeFeedback(workspace, 'ghs_test_token', {
      pr: 42,
      owner: 'acme',
      repo: 'rocket',
    });

    assert.deepEqual(result.unresolvedThreads, [
      {
        threadId: 'PRRT_human',
        commentId: 101,
        author: 'octocat',
        source: 'humans',
        body: 'Human feedback.',
        path: 'src/app.mjs',
        line: 12,
      },
    ]);
  });
});
