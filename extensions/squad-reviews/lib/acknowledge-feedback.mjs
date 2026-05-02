import { fetchPrThreads } from './github-api.mjs';
import { loadConfig } from './review-config.mjs';

const COPILOT_BOT_AUTHORS = new Set([
  'github-copilot[bot]',
  'copilot-pull-request-reviewer[bot]',
]);

const INSTRUCTION = [
  'Batch feedback per PR: address all related unresolved threads in one implementation pass, validate once, and create one commit for the batch.',
  'Do not make one commit or one push per thread; each synchronize can create notification noise and trigger repeated approval invalidation or rebases.',
  'After pushing, post or update ONE consolidated PR comment with squad_reviews_post_feedback_batch listing every thread you addressed (with the batch commit SHA and a one-line description per thread). This is the audit record.',
  'Then resolve threads. For action=addressed: do NOT post a per-thread reply — the consolidated PR comment is the acknowledgment. For action=dismissed: post a per-thread reply with the justification (substantive pushback belongs at the line).',
  "For each thread after the batch is pushed: call squad_reviews_resolve_thread with action='addressed' and the batch commit SHA, OR call with action='dismissed' and justification.",
  'After all threads are resolved, check PR reviewDecision. If it is still CHANGES_REQUESTED, ping the human reviewer for re-review/dismissal; separately submit any required Squad role-gate approval with squad_reviews_execute_pr_review.',
].join(' ');

function getSquadAgentAuthors(config) {
  return new Set(
    Object.values(config.reviewers)
      .map((reviewer) => reviewer?.agent)
      .filter((agent) => typeof agent === 'string' && agent.trim() !== '')
      .map((agent) => `${agent.toLowerCase()}[bot]`),
  );
}

function categorizeAuthor(author, squadAgentAuthors) {
  if (typeof author === 'string') {
    const normalizedAuthor = author.toLowerCase();

    if (COPILOT_BOT_AUTHORS.has(normalizedAuthor)) {
      return 'github-copilot-bot';
    }

    if (normalizedAuthor.endsWith('[bot]') && squadAgentAuthors.has(normalizedAuthor)) {
      return 'squad-agents';
    }
  }

  return 'humans';
}

export async function acknowledgeFeedback(repoRoot, token, { pr, owner, repo }) {
  const config = loadConfig(repoRoot);
  const feedbackSources = new Set(config.feedbackSources);
  const squadAgentAuthors = getSquadAgentAuthors(config);
  const threads = await fetchPrThreads(token, owner, repo, pr);

  const unresolvedThreads = threads
    .filter((thread) => thread.isResolved === false)
    .map((thread) => {
      const source = categorizeAuthor(thread.author, squadAgentAuthors);

      return {
        threadId: thread.threadId,
        commentId: thread.commentId,
        author: thread.author,
        source,
        body: thread.body,
        path: thread.path,
        line: thread.line,
      };
    })
    .filter((thread) => feedbackSources.has(thread.source));

  return {
    unresolvedThreads,
    totalUnresolved: unresolvedThreads.length,
    instruction: INSTRUCTION,
    batchPlan: {
      mode: 'batched-per-pr',
      implementation: 'Fix all actionable unresolved threads for this PR together before committing.',
      commit: 'Create one commit for the feedback batch; avoid per-thread commits/pushes.',
      comment: 'Use squad_reviews_post_feedback_batch to post or update one consolidated PR comment with the batch commit SHA and per-reviewer summary before resolving threads.',
      resolve: 'Resolve individual threads only after the batch commit/comment exists.',
      closure: 'After totalUnresolved reaches 0, check reviewDecision. CHANGES_REQUESTED still requires a human re-review/dismissal ping, while Squad role-gate approval must be submitted separately via squad_reviews_execute_pr_review.',
    },
  };
}
