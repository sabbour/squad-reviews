import { appendAuditEntry } from './audit-log.mjs';
import { upsertIssueComment } from './github-api.mjs';

export const FEEDBACK_BATCH_MARKER = '<!-- squad-feedback-batch -->';

function assertNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
}

function assertPositiveInteger(value, fieldName) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }
}

function normalizeThread(thread) {
  if (!thread || typeof thread !== 'object' || Array.isArray(thread)) {
    throw new Error('threads entries must be objects');
  }

  const action = thread.action || 'addressed';
  if (!['addressed', 'dismissed'].includes(action)) {
    throw new Error('thread.action must be addressed or dismissed');
  }

  const summary = typeof thread.summary === 'string' && thread.summary.trim() !== ''
    ? thread.summary.trim()
    : action;
  const location = [thread.path, thread.line ? `L${thread.line}` : null].filter(Boolean).join(':');
  const reference = thread.threadId || thread.commentId || location || 'thread';

  return {
    action,
    summary,
    reference,
    location,
  };
}

export function buildFeedbackBatchComment({ sha, summary, threads = [] }) {
  assertNonEmptyString(sha, 'sha');
  assertNonEmptyString(summary, 'summary');

  const normalizedThreads = threads.map(normalizeThread);
  const lines = [
    FEEDBACK_BATCH_MARKER,
    '## Batched review feedback update',
    '',
    `Commit: \`${sha.trim()}\``,
    '',
    summary.trim(),
  ];

  if (normalizedThreads.length > 0) {
    lines.push('', '### Threads covered');
    for (const thread of normalizedThreads) {
      const location = thread.location ? ` (${thread.location})` : '';
      lines.push(`- **${thread.action}** ${thread.reference}${location}: ${thread.summary}`);
    }
  }

  lines.push(
    '',
    '_Batched by Squad: one implementation pass, one validation run, and one feedback-fix commit where possible._',
  );

  return lines.join('\n');
}

export async function postFeedbackBatch(repoRoot, token, options) {
  assertNonEmptyString(repoRoot, 'repoRoot');
  assertNonEmptyString(token, 'token');
  assertNonEmptyString(options.owner, 'owner');
  assertNonEmptyString(options.repo, 'repo');
  assertPositiveInteger(options.pr, 'pr');

  const body = buildFeedbackBatchComment(options);
  const result = await upsertIssueComment(token, options.owner, options.repo, options.pr, {
    marker: FEEDBACK_BATCH_MARKER,
    body,
  });

  appendAuditEntry(repoRoot, {
    action: 'feedback_batch_comment',
    pr: options.pr,
    owner: options.owner,
    repo: options.repo,
    sha: options.sha,
    commentId: result.commentId,
    updated: result.updated,
    threadCount: Array.isArray(options.threads) ? options.threads.length : 0,
  });

  return {
    ...result,
    marker: FEEDBACK_BATCH_MARKER,
    instruction: 'Use this consolidated comment as the batch summary, then resolve individual review threads with concise replies that reference the same commit SHA.',
  };
}
