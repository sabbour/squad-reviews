import { applyLabel, postComment } from './github-api.mjs';
import { loadConfig, resolveReviewer } from './review-config.mjs';

export async function executeIssueReview(
  repoRoot,
  token,
  { issue, roleSlug, reviewBody, approved, owner, repo },
) {
  const config = loadConfig(repoRoot);
  const reviewer = resolveReviewer(config, roleSlug);

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
  };
}
