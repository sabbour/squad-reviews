import { loadConfig } from './review-config.mjs';
import {
  fetchPrClosureStatus,
  replyToThread as githubReplyToThread,
  resolveThread as githubResolveThread,
} from './github-api.mjs';
import { appendAuditEntry } from './audit-log.mjs';

const ADDRESS_REPLY_PATTERN = /^(?<sha>[0-9a-f]{7,40})\s*:\s*(?<description>\S[\s\S]*)$/;
const DISMISS_REPLY_PATTERN = /^justification\s*:\s*(?<justification>\S[\s\S]*)$/i;
const DEFAULT_RESOLVE_RETRY_DELAYS_MS = [500, 1000, 2000];

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

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function renderTemplate(template, replacements) {
  let rendered = template;

  for (const [key, value] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(`{${key}}`, value);
  }

  return rendered;
}

function normalizeAddressedReply(template, reply) {
  if (isPlainObject(reply)) {
    assertNonEmptyString(reply.sha, 'reply.sha');
    assertNonEmptyString(reply.description, 'reply.description');
    return renderTemplate(template, {
      sha: reply.sha.trim(),
      description: reply.description.trim(),
    });
  }

  assertNonEmptyString(reply, 'reply');
  const trimmedReply = reply.trim();
  const match = trimmedReply.match(ADDRESS_REPLY_PATTERN);

  if (!match?.groups) {
    return trimmedReply;
  }

  return renderTemplate(template, {
    sha: match.groups.sha.trim(),
    description: match.groups.description.trim(),
  });
}

function normalizeDismissedReply(template, reply) {
  if (isPlainObject(reply)) {
    assertNonEmptyString(reply.justification, 'reply.justification');
    return renderTemplate(template, {
      justification: reply.justification.trim(),
    });
  }

  assertNonEmptyString(reply, 'reply');
  const trimmedReply = reply.trim();
  const match = trimmedReply.match(DISMISS_REPLY_PATTERN);

  if (!match?.groups) {
    return trimmedReply;
  }

  return renderTemplate(template, {
    justification: match.groups.justification.trim(),
  });
}

function formatReply(templates, { action, reply, sha, description, justification }) {
  if (action === 'addressed') {
    if (reply !== undefined) {
      return normalizeAddressedReply(templates.addressed, reply);
    }

    assertNonEmptyString(sha, 'sha');
    assertNonEmptyString(description, 'description');
    return renderTemplate(templates.addressed, {
      sha: sha.trim(),
      description: description.trim(),
    });
  }

  if (action === 'dismissed') {
    if (reply !== undefined) {
      return normalizeDismissedReply(templates.dismissed, reply);
    }

    assertNonEmptyString(justification, 'justification');
    return renderTemplate(templates.dismissed, {
      justification: justification.trim(),
    });
  }

  throw new Error(`Unsupported action: ${action}`);
}

function sleep(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function buildResolveRetryDelays({ maxResolveAttempts, retryDelayMs }) {
  if (maxResolveAttempts === undefined && retryDelayMs === undefined) {
    return DEFAULT_RESOLVE_RETRY_DELAYS_MS;
  }

  const totalAttempts = maxResolveAttempts ?? DEFAULT_RESOLVE_RETRY_DELAYS_MS.length + 1;
  if (!Number.isInteger(totalAttempts) || totalAttempts < 1) {
    throw new Error('maxResolveAttempts must be a positive integer');
  }

  if (retryDelayMs === undefined) {
    return DEFAULT_RESOLVE_RETRY_DELAYS_MS.slice(0, Math.max(totalAttempts - 1, 0));
  }

  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new Error('retryDelayMs must be a non-negative integer');
  }

  return Array.from({ length: Math.max(totalAttempts - 1, 0) }, () => retryDelayMs);
}

function createDefaultDeps() {
  return {
    replyToThread: ({ token, owner, repo, prNumber, commentId, body }) =>
      githubReplyToThread(token, owner, repo, prNumber, commentId, body),
    resolveThread: ({ token, threadId }) => githubResolveThread(token, threadId),
    getClosureStatus: ({ token, owner, repo, prNumber }) =>
      fetchPrClosureStatus(token, owner, repo, prNumber),
    sleep,
  };
}

function isBotLogin(login) {
  return typeof login === 'string' && login.toLowerCase().endsWith('[bot]');
}

function buildClosureRule(status) {
  const remainingUnresolvedThreads = status?.unresolvedThreads ?? null;
  const reviewDecision = status?.reviewDecision ?? null;
  const allThreadsResolved = remainingUnresolvedThreads === 0;
  const humanReviewersNeedingReReview = (status?.changeRequestReviewers ?? [])
    .filter((login) => !isBotLogin(login));
  const reviewDecisionStillChangesRequested = reviewDecision === 'CHANGES_REQUESTED';

  return {
    allThreadsResolved,
    reviewDecision,
    remainingUnresolvedThreads,
    humanReviewersNeedingReReview,
    humanReReviewRequired: allThreadsResolved && reviewDecisionStillChangesRequested,
    roleGateApprovalRequired: allThreadsResolved,
    instruction: allThreadsResolved
      ? 'All threads are resolved. Check PR reviewDecision now. If it is still CHANGES_REQUESTED, ping the human reviewer for re-review or dismissal; separately submit any required Squad role-gate approval with squad_reviews_execute_pr_review.'
      : 'Continue resolving remaining threads before checking reviewDecision or submitting role-gate approval.',
  };
}

async function resolveWithRetry({ token, threadId, retryDelaysMs }, deps) {
  let lastError;

  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      await deps.resolveThread({ token, threadId });
      return;
    } catch (error) {
      lastError = error;
    }

    if (attempt < retryDelaysMs.length) {
      await deps.sleep(retryDelaysMs[attempt]);
    }
  }

  throw new Error(`Failed to resolve thread ${threadId} after ${retryDelaysMs.length + 1} attempts`, {
    cause: lastError,
  });
}

async function executeResolveFlow({
  token,
  owner,
  repo,
  prNumber,
  threadId,
  commentId,
  action,
  config,
  reply,
  sha,
  description,
  justification,
  maxResolveAttempts,
  retryDelayMs,
}, deps) {
  assertNonEmptyString(token, 'token');
  assertNonEmptyString(owner, 'owner');
  assertNonEmptyString(repo, 'repo');
  assertNonEmptyString(threadId, 'threadId');
  assertPositiveInteger(prNumber, 'pr');

  if (commentId !== undefined) {
    if (typeof commentId === 'string' && /^[A-Za-z]/.test(commentId)) {
      throw new Error('commentId must be a numeric database ID, not a GraphQL node_id');
    }
    assertPositiveInteger(commentId, 'commentId');
  } else {
    throw new Error('commentId is required (must be a numeric database ID)');
  }

  const formattedReply = formatReply(config.threadResolution.templates, {
    action,
    reply,
    sha,
    description,
    justification,
  });

  const replyId = await deps.replyToThread({
    token,
    owner,
    repo,
    prNumber,
    commentId,
    body: formattedReply,
  });

  await resolveWithRetry(
    {
      token,
      threadId,
      retryDelaysMs: buildResolveRetryDelays({ maxResolveAttempts, retryDelayMs }),
    },
    deps,
  );

  const closureStatus = await deps.getClosureStatus({ token, owner, repo, prNumber });

  return {
    resolved: true,
    replyId: String(replyId),
    action,
    closureRule: buildClosureRule(closureStatus),
  };
}

export async function resolveReviewThread(options, dependencies = {}) {
  const deps = {
    ...createDefaultDeps(),
    ...dependencies,
  };
  const config = options.config ?? loadConfig(options.repoRoot);
  const prNumber = options.pr ?? options.pullNumber;

  return executeResolveFlow(
    {
      ...options,
      config,
      prNumber,
    },
    deps,
  );
}

export async function resolveThread(repoRoot, token, options) {
  assertNonEmptyString(repoRoot, 'repoRoot');

  const result = await resolveReviewThread({
    ...options,
    repoRoot,
    token,
    pr: options.pr,
  });

  appendAuditEntry(repoRoot, {
    action: 'thread_resolved',
    pr: options.pr,
    owner: options.owner,
    repo: options.repo,
    threadId: options.threadId,
    resolveAction: options.action,
  });

  return result;
}
