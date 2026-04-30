import test from 'node:test';
import assert from 'node:assert/strict';
import { requestIssueReview, requestPrReview } from '../extensions/squad-reviews/lib/request-review.mjs';

const repoRoot = new URL('./fixtures/request-review/repo/', import.meta.url);

test('requestPrReview returns the structured PR review request', () => {
  const result = requestPrReview(repoRoot.pathname, {
    pr: '17',
    reviewer: 'security',
    owner: 'octo-org',
    repo: 'hello-world',
  });

  assert.deepEqual(result, {
    status: 'review_requested',
    reviewer: 'Rose',
    roleSlug: 'security',
    charterPath: '.squad/agents/rose/charter.md',
    dimension: 'security risks and abuse resistance',
    pr: 17,
    owner: 'octo-org',
    repo: 'hello-world',
    instruction: "Dispatch Rose to execute: squad_reviews_execute_pr_review(pr=17, roleSlug='security')",
  });
});

test('requestIssueReview returns the structured issue review request', () => {
  const result = requestIssueReview(repoRoot.pathname, {
    issue: 29,
    reviewer: 'design',
    owner: 'octo-org',
    repo: 'hello-world',
  });

  assert.deepEqual(result, {
    status: 'review_requested',
    reviewer: 'Holdo',
    roleSlug: 'design',
    charterPath: '.squad/agents/holdo/charter.md',
    dimension: 'product shape and UX coherence',
    issue: 29,
    owner: 'octo-org',
    repo: 'hello-world',
    instruction: "Dispatch Holdo to execute: squad_reviews_execute_issue_review(issue=29, roleSlug='design')",
  });
});

test('requestPrReview throws for an unknown reviewer role', () => {
  assert.throws(
    () => requestPrReview(repoRoot.pathname, {
      pr: 3,
      reviewer: 'unknown-role',
      owner: 'octo-org',
      repo: 'hello-world',
    }),
    /Unknown reviewer role: unknown-role/
  );
});
