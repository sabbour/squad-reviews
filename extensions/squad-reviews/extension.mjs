import { joinSession } from '@github/copilot-sdk/extension';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { execFile } from 'node:child_process';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { acknowledgeFeedback } from './lib/acknowledge-feedback.mjs';
import { executePrReview } from './lib/execute-review.mjs';
import { executeIssueReview } from './lib/issue-review.mjs';
import { loadConfig } from './lib/review-config.mjs';
import { requestIssueReview, requestPrReview } from './lib/request-review.mjs';
import { resolveThread } from './lib/resolve-thread.mjs';
import { scaffoldGate } from './lib/scaffold-gate.mjs';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = join(__dirname, 'lib');
const REPO_ROOT = resolveRepoRoot(__dirname);
const REVIEWS_DIR = join(REPO_ROOT, 'reviews');
const CONFIG_TEMPLATE_PATH = join(REVIEWS_DIR, 'config.json.template');
const CONFIG_PATH = join(REVIEWS_DIR, 'config.json');
const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_API_BASE_URL = 'https://api.github.com';
const MISSING_TOKEN_ERROR = 'Missing GitHub token. Set SQUAD_REVIEW_TOKEN, GH_TOKEN, or GITHUB_TOKEN.';

function resolveRepoRoot(startDir) {
  const candidates = [
    join(startDir, '..', '..', '..'),
    join(startDir, '..', '..'),
  ];

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json')) && existsSync(join(candidate, 'reviews'))) {
      return candidate;
    }
  }

  return join(startDir, '..', '..', '..');
}

function textResponse(payload) {
  return { type: 'text', text: JSON.stringify(payload, null, 2) };
}

function normalizeError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return 'Unknown error';
}

function registerJsonTool(session, definition) {
  session.registerTool({
    ...definition,
    handler: async (params = {}) => {
      try {
        return textResponse(await definition.handler(params));
      } catch (error) {
        return textResponse({ error: normalizeError(error) });
      }
    },
  });
}

function resolveToken() {
  return process.env.SQUAD_REVIEW_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null;
}

function requireToken() {
  const token = resolveToken();

  if (!token) {
    throw new Error(`${MISSING_TOKEN_ERROR} You can export one directly or provision one through squad-identity.`);
  }

  return token;
}

function normalizePositiveInteger(value, fieldName) {
  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }

  return number;
}

function normalizeCommentId(value) {
  if (typeof value === 'number') {
    return normalizePositiveInteger(value, 'commentId');
  }

  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return normalizePositiveInteger(Number(value.trim()), 'commentId');
  }

  throw new Error('commentId must be a numeric string');
}

function getStatusSummary() {
  const configExists = existsSync(CONFIG_PATH);
  const summary = {
    repoRoot: REPO_ROOT,
    libDir: LIB_DIR,
    configPath: CONFIG_PATH,
    configExists,
    templatePath: CONFIG_TEMPLATE_PATH,
    templateExists: existsSync(CONFIG_TEMPLATE_PATH),
  };

  if (!configExists) {
    return {
      ...summary,
      configured: false,
      message: 'Run squad_reviews_setup to create reviews/config.json from the template.',
    };
  }

  const config = loadConfig(REPO_ROOT);
  const reviewers = Object.entries(config.reviewers).map(([roleSlug, reviewer]) => ({
    roleSlug,
    agent: reviewer.agent,
    dimension: reviewer.dimension,
    charterPath: reviewer.charterPath,
  }));

  return {
    ...summary,
    configured: true,
    schemaVersion: config.schemaVersion,
    reviewerCount: reviewers.length,
    reviewers,
    feedbackSources: config.feedbackSources,
    requireReplyBeforeResolve: config.threadResolution.requireReplyBeforeResolve,
    threadTemplates: config.threadResolution.templates,
  };
}

function parseGitHubRemote(remoteUrl) {
  if (typeof remoteUrl !== 'string' || remoteUrl.trim() === '') {
    return null;
  }

  const trimmedUrl = remoteUrl.trim().replace(/^git\+/, '');
  const sshMatch = trimmedUrl.match(/^git@github\.com:(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/);
  if (sshMatch?.groups) {
    return sshMatch.groups;
  }

  const httpsMatch = trimmedUrl.match(/^https?:\/\/github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?\/?$/);
  if (httpsMatch?.groups) {
    return httpsMatch.groups;
  }

  return null;
}

async function resolveRepositoryCoordinates() {
  const fromEnv = process.env.GITHUB_REPOSITORY;
  if (typeof fromEnv === 'string' && fromEnv.includes('/')) {
    const [owner, repo] = fromEnv.split('/');
    if (owner && repo) {
      return { owner, repo };
    }
  }

  try {
    const { stdout } = await execFileAsync('git', ['-C', REPO_ROOT, 'remote', 'get-url', 'origin'], { timeout: 5000 });
    const parsed = parseGitHubRemote(stdout);
    if (parsed) {
      return parsed;
    }
  } catch {
    // Ignore and fall back to package.json.
  }

  try {
    const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
    const repository = packageJson?.repository;
    const remoteUrl = typeof repository === 'string' ? repository : repository?.url;
    const parsed = parseGitHubRemote(remoteUrl);
    if (parsed) {
      return parsed;
    }
  } catch {
    // Ignore and report unresolved coordinates.
  }

  return null;
}

function buildGitHubHeaders(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };

  if (token) {
    headers.Authorization = `token ${token}`;
  }

  return headers;
}

function getNextPageUrl(linkHeader) {
  if (!linkHeader) {
    return null;
  }

  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (match?.[2] === 'next') {
      return match[1];
    }
  }

  return null;
}

async function fetchAllLabels({ owner, repo, token }) {
  const labels = [];
  let url = `${GITHUB_API_BASE_URL}/repos/${owner}/${repo}/labels?per_page=100`;

  while (url) {
    const response = await fetch(url, {
      method: 'GET',
      headers: buildGitHubHeaders(token),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GET ${url} failed with ${response.status}: ${body || '<empty response body>'}`);
    }

    labels.push(...await response.json());
    url = getNextPageUrl(response.headers.get('link'));
  }

  return labels;
}

function getSquadIdentityStatus() {
  const installedPaths = [
    join(REPO_ROOT, '.github', 'extensions', 'squad-identity', 'extension.mjs'),
    join(REPO_ROOT, 'extensions', 'squad-identity', 'extension.mjs'),
  ];
  const installedPath = installedPaths.find((candidate) => existsSync(candidate)) || null;

  return {
    installed: Boolean(installedPath),
    path: installedPath,
  };
}

async function runDoctor() {
  const report = {
    repoRoot: REPO_ROOT,
    checks: {
      configExists: existsSync(CONFIG_PATH),
      configValid: false,
      squadIdentityInstalled: false,
      labelsExist: false,
    },
    details: {},
    issues: [],
  };

  let config;
  if (report.checks.configExists) {
    try {
      config = loadConfig(REPO_ROOT);
      report.checks.configValid = true;
      report.details.schemaVersion = config.schemaVersion;
      report.details.reviewers = Object.keys(config.reviewers);
    } catch (error) {
      report.issues.push(`Config invalid: ${normalizeError(error)}`);
    }
  } else {
    report.issues.push(`Config missing: ${CONFIG_PATH}`);
  }

  const identity = getSquadIdentityStatus();
  report.checks.squadIdentityInstalled = identity.installed;
  report.details.squadIdentity = identity;
  if (!identity.installed) {
    report.issues.push('squad-identity extension not found under .github/extensions or extensions.');
  }

  if (config) {
    const coordinates = await resolveRepositoryCoordinates();
    report.details.repository = coordinates;

    if (!coordinates) {
      report.issues.push('Could not determine GitHub owner/repo to verify review labels.');
    } else {
      try {
        const labels = await fetchAllLabels({
          ...coordinates,
          token: resolveToken(),
        });
        const existingLabels = new Set(labels.map((label) => label.name));
        const expectedLabels = Object.keys(config.reviewers).map((roleSlug) => `${roleSlug}:approved`);
        const missingLabels = expectedLabels.filter((label) => !existingLabels.has(label));

        report.checks.labelsExist = missingLabels.length === 0;
        report.details.labels = {
          expected: expectedLabels,
          missing: missingLabels,
          totalFound: labels.length,
        };

        if (missingLabels.length > 0) {
          report.issues.push(`Missing labels: ${missingLabels.join(', ')}`);
        }
      } catch (error) {
        report.issues.push(`Label check failed: ${normalizeError(error)}`);
      }
    }
  }

  report.ok = report.issues.length === 0;
  return report;
}

function setupConfig() {
  if (!existsSync(CONFIG_TEMPLATE_PATH)) {
    throw new Error(`Template not found at ${CONFIG_TEMPLATE_PATH}`);
  }

  mkdirSync(REVIEWS_DIR, { recursive: true });

  if (existsSync(CONFIG_PATH)) {
    return {
      created: false,
      configPath: CONFIG_PATH,
      message: 'reviews/config.json already exists.',
      nextSteps: [
        'Review the existing config and update reviewer mappings as needed.',
        'Verify charterPath values point at your team agent charters.',
        'Run squad_reviews_status or squad_reviews_doctor to validate the setup.',
      ],
    };
  }

  copyFileSync(CONFIG_TEMPLATE_PATH, CONFIG_PATH);

  return {
    created: true,
    configPath: CONFIG_PATH,
    copiedFrom: CONFIG_TEMPLATE_PATH,
    nextSteps: [
      'Edit reviews/config.json to map role slugs to your team agents.',
      'Adjust feedbackSources and threadResolution templates for your workflow.',
      'Commit reviews/config.json after customization.',
    ],
  };
}

joinSession(async session => {
  registerJsonTool(session, {
    name: 'squad_reviews_request_pr_review',
    description: 'Request a PR review from a configured Squad reviewer role.',
    inputSchema: {
      type: 'object',
      properties: {
        pr: { type: 'number' },
        reviewer: { type: 'string' },
        owner: { type: 'string' },
        repo: { type: 'string' },
      },
      required: ['pr', 'reviewer', 'owner', 'repo'],
    },
    handler: async ({ pr, reviewer, owner, repo }) =>
      requestPrReview(REPO_ROOT, { pr, reviewer, owner, repo }),
  });

  registerJsonTool(session, {
    name: 'squad_reviews_execute_pr_review',
    description: 'Execute a PR review using the configured reviewer charter and GitHub bot token.',
    inputSchema: {
      type: 'object',
      properties: {
        pr: { type: 'number' },
        roleSlug: { type: 'string' },
        event: { type: 'string', enum: ['COMMENT', 'REQUEST_CHANGES'] },
        reviewBody: { type: 'string' },
        owner: { type: 'string' },
        repo: { type: 'string' },
      },
      required: ['pr', 'roleSlug', 'event', 'owner', 'repo'],
    },
    handler: async ({ pr, roleSlug, event, reviewBody, owner, repo }) =>
      executePrReview(REPO_ROOT, requireToken(), { pr, roleSlug, event, reviewBody, owner, repo }),
  });

  registerJsonTool(session, {
    name: 'squad_reviews_acknowledge_feedback',
    description: 'List unresolved PR review threads that must be addressed or dismissed.',
    inputSchema: {
      type: 'object',
      properties: {
        pr: { type: 'number' },
        owner: { type: 'string' },
        repo: { type: 'string' },
      },
      required: ['pr', 'owner', 'repo'],
    },
    handler: async ({ pr, owner, repo }) =>
      acknowledgeFeedback(REPO_ROOT, requireToken(), { pr, owner, repo }),
  });

  registerJsonTool(session, {
    name: 'squad_reviews_resolve_thread',
    description: 'Reply to a PR review thread, then resolve it as addressed or dismissed.',
    inputSchema: {
      type: 'object',
      properties: {
        pr: { type: 'number' },
        threadId: { type: 'string' },
        commentId: { type: 'string' },
        reply: { type: 'string' },
        action: { type: 'string', enum: ['addressed', 'dismissed'] },
        owner: { type: 'string' },
        repo: { type: 'string' },
      },
      required: ['pr', 'threadId', 'commentId', 'reply', 'action', 'owner', 'repo'],
    },
    handler: async ({ pr, threadId, commentId, reply, action, owner, repo }) =>
      resolveThread(REPO_ROOT, requireToken(), {
        pr,
        threadId,
        commentId: normalizeCommentId(commentId),
        reply,
        action,
        owner,
        repo,
      }),
  });

  registerJsonTool(session, {
    name: 'squad_reviews_request_issue_review',
    description: 'Request an issue review from a configured Squad reviewer role.',
    inputSchema: {
      type: 'object',
      properties: {
        issue: { type: 'number' },
        reviewer: { type: 'string' },
        owner: { type: 'string' },
        repo: { type: 'string' },
      },
      required: ['issue', 'reviewer', 'owner', 'repo'],
    },
    handler: async ({ issue, reviewer, owner, repo }) =>
      requestIssueReview(REPO_ROOT, { issue, reviewer, owner, repo }),
  });

  registerJsonTool(session, {
    name: 'squad_reviews_execute_issue_review',
    description: 'Execute an issue review and optionally apply the approval label.',
    inputSchema: {
      type: 'object',
      properties: {
        issue: { type: 'number' },
        roleSlug: { type: 'string' },
        reviewBody: { type: 'string' },
        approved: { type: 'boolean' },
        owner: { type: 'string' },
        repo: { type: 'string' },
      },
      required: ['issue', 'roleSlug', 'reviewBody', 'approved', 'owner', 'repo'],
    },
    handler: async ({ issue, roleSlug, reviewBody, approved, owner, repo }) =>
      executeIssueReview(REPO_ROOT, requireToken(), { issue, roleSlug, reviewBody, approved, owner, repo }),
  });

  registerJsonTool(session, {
    name: 'squad_reviews_status',
    description: 'Show the current Squad review configuration and registered reviewers.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => getStatusSummary(),
  });

  registerJsonTool(session, {
    name: 'squad_reviews_doctor',
    description: 'Run health checks for the Squad review extension setup.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => runDoctor(),
  });

  registerJsonTool(session, {
    name: 'squad_reviews_setup',
    description: 'Create reviews/config.json from the template if it does not already exist.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => setupConfig(),
  });

  registerJsonTool(session, {
    name: 'squad_reviews_scaffold_gate',
    description: 'Scaffold review gate CI workflows (reusable + caller) for the configured reviewer roles.',
    inputSchema: {
      type: 'object',
      properties: {
        roles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Reviewer role slugs to require. Defaults to all roles from config.',
        },
      },
      required: [],
    },
    handler: async ({ roles }) => scaffoldGate(REPO_ROOT, { roles }),
  });
});
