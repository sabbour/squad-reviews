import { fetchPrThreads } from './github-api.mjs';
import { loadConfig } from './review-config.mjs';

const COPILOT_BOT_AUTHORS = new Set([
  'github-copilot[bot]',
  'copilot-pull-request-reviewer[bot]',
]);

const INSTRUCTION = "For each thread: fix code and call squad_reviews_resolve_thread with action='addressed' and the commit SHA, OR call with action='dismissed' and justification.";

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
  };
}
