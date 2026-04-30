import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fetchPrDiff, fetchPrHead, fetchPrReviews, postReview } from './github-api.mjs';
import { loadConfig, resolveReviewer, resolveBotLogin } from './review-config.mjs';
import { appendAuditEntry } from './audit-log.mjs';
import { validateReviewQuality } from './review-quality.mjs';

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

export async function executePrReview(repoRoot, token, { pr, roleSlug, event, reviewBody, comments, owner, repo }) {
  const config = loadConfig(repoRoot);
  const reviewer = resolveReviewer(config, roleSlug);

  validateEvent(event);

  const charter = readCharter(repoRoot, reviewer.charterPath);
  const diff = await fetchPrDiff(token, owner, repo, pr);

  if (reviewBody !== undefined) {
    // Duplicate review guard: check if this bot already reviewed the current HEAD
    const botLogin = resolveBotLogin(roleSlug, repoRoot);
    if (botLogin) {
      const [headSha, existingReviews] = await Promise.all([
        fetchPrHead(token, owner, repo, pr),
        fetchPrReviews(token, owner, repo, pr),
      ]);

      const duplicateReview = existingReviews.find(r =>
        r.user?.login?.toLowerCase() === botLogin.toLowerCase() &&
        r.commit_id === headSha
      );

      if (duplicateReview) {
        return {
          posted: false,
          skipped: true,
          reason: `Review already exists for commit ${headSha.slice(0, 7)} by ${botLogin}`,
          existingReviewId: String(duplicateReview.id),
          existingState: duplicateReview.state,
        };
      }
    }

    // Validate review quality before posting
    const inlineComments = (comments || []).map(c => c.body || '');
    const quality = validateReviewQuality(reviewBody, event, { inlineComments });

    if (!quality.valid) {
      return {
        posted: false,
        rejected: true,
        violations: quality.violations,
        metrics: quality.metrics,
        hint: 'Revise the review to meet quality standards. See SKILL.md "Review Quality Standards" for requirements.',
      };
    }

    const reviewPayload = { body: reviewBody, event };
    // Support inline comments with native suggestions
    if (comments && comments.length > 0) {
      reviewPayload.comments = comments;
    }

    const reviewId = await postReview(token, owner, repo, pr, reviewPayload);

    appendAuditEntry(repoRoot, {
      action: 'review_posted',
      pr,
      owner,
      repo,
      roleSlug,
      event,
      reviewId: String(reviewId),
      quality: quality.metrics,
    });

    return {
      posted: true,
      reviewId: String(reviewId),
      event,
      reviewer: reviewer.agent,
      quality: quality.metrics,
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
