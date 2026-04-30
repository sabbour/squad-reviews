import { loadConfig, resolveReviewer } from './review-config.mjs';

function assertNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return value.trim();
}

function normalizePositiveInteger(value, fieldName) {
  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }

  return number;
}

function buildInstruction(agent, command, fieldName, number, roleSlug) {
  return `Dispatch ${agent} to execute: ${command}(${fieldName}=${number}, roleSlug='${roleSlug}')`;
}

function buildReviewRequest(repoRoot, { artifactType, artifactNumber, reviewer, owner, repo, command }) {
  assertNonEmptyString(repoRoot, 'repoRoot');
  const roleSlug = assertNonEmptyString(reviewer, 'reviewer');
  const repoOwner = assertNonEmptyString(owner, 'owner');
  const repoName = assertNonEmptyString(repo, 'repo');
  const number = normalizePositiveInteger(artifactNumber, artifactType);

  const config = loadConfig(repoRoot);
  const resolvedReviewer = resolveReviewer(config, roleSlug);

  return {
    status: 'review_requested',
    reviewer: resolvedReviewer.agent,
    roleSlug,
    charterPath: resolvedReviewer.charterPath,
    dimension: resolvedReviewer.dimension,
    [artifactType]: number,
    owner: repoOwner,
    repo: repoName,
    instruction: buildInstruction(resolvedReviewer.agent, command, artifactType, number, roleSlug),
  };
}

export function requestPrReview(repoRoot, { pr, reviewer, owner, repo }) {
  return buildReviewRequest(repoRoot, {
    artifactType: 'pr',
    artifactNumber: pr,
    reviewer,
    owner,
    repo,
    command: 'squad_reviews_execute_pr_review',
  });
}

export function requestIssueReview(repoRoot, { issue, reviewer, owner, repo }) {
  return buildReviewRequest(repoRoot, {
    artifactType: 'issue',
    artifactNumber: issue,
    reviewer,
    owner,
    repo,
    command: 'squad_reviews_execute_issue_review',
  });
}
