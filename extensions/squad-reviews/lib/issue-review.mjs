import { applyLabel, postComment } from './github-api.mjs';
import { loadConfig, resolveReviewer } from './review-config.mjs';
import { validateReviewQuality } from './review-quality.mjs';

export async function executeIssueReview(
  repoRoot,
  token,
  { issue, roleSlug, reviewBody, approved, owner, repo },
) {
  const config = loadConfig(repoRoot);
  const reviewer = resolveReviewer(config, roleSlug);

  // Validate review quality
  const event = approved ? 'APPROVE' : 'COMMENT';
  const quality = validateReviewQuality(reviewBody, event);

  if (!quality.valid) {
    return {
      posted: false,
      rejected: true,
      violations: quality.violations,
      metrics: quality.metrics,
      hint: 'Revise the review to meet quality standards. See SKILL.md "Review Quality Standards" for requirements.',
    };
  }

  const commentId = await postComment(token, owner, repo, issue, reviewBody);

  let labelApplied = null;
  if (approved === true) {
    labelApplied = `${roleSlug}:approved`;
    await applyLabel(token, owner, repo, issue, labelApplied);
  }

  return {
    posted: true,
    commentId,
    labelApplied,
    reviewer: reviewer.agent,
    issue,
    quality: quality.metrics,
  };
}
