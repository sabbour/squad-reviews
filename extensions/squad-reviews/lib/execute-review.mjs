import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fetchPrDiff, postReview } from './github-api.mjs';
import { loadConfig, resolveReviewer } from './review-config.mjs';
import { appendAuditEntry } from './audit-log.mjs';

const VALID_REVIEW_EVENTS = new Set(['COMMENT', 'REQUEST_CHANGES', 'APPROVE']);

function validateEvent(event) {
  if (!VALID_REVIEW_EVENTS.has(event)) {
    throw new Error(`Invalid review event: ${event}. Expected COMMENT, REQUEST_CHANGES, or APPROVE`);
  }
}

function readCharter(repoRoot, charterPath) {
  const absoluteCharterPath = join(repoRoot, charterPath);

  try {
    return readFileSync(absoluteCharterPath, 'utf-8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`Charter not found at ${absoluteCharterPath}`);
    }

    throw error;
  }
}

export async function executePrReview(repoRoot, token, { pr, roleSlug, event, reviewBody, owner, repo }) {
  const config = loadConfig(repoRoot);
  const reviewer = resolveReviewer(config, roleSlug);

  validateEvent(event);

  const charter = readCharter(repoRoot, reviewer.charterPath);
  const diff = await fetchPrDiff(token, owner, repo, pr);

  if (reviewBody !== undefined) {
    const reviewId = await postReview(token, owner, repo, pr, reviewBody, event);

    appendAuditEntry(repoRoot, {
      action: 'review_posted',
      pr,
      owner,
      repo,
      roleSlug,
      event,
      reviewId: String(reviewId),
    });

    return {
      posted: true,
      reviewId: String(reviewId),
      event,
      reviewer: reviewer.agent,
    };
  }

  return {
    posted: false,
    charter,
    diff,
    reviewer: reviewer.agent,
    dimension: reviewer.dimension,
  };
}
