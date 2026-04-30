import { approveAll } from '@github/copilot-sdk';
import { joinSession } from '@github/copilot-sdk/extension';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { acknowledgeFeedback } from './lib/acknowledge-feedback.mjs';
import { checkGateStatus } from './lib/gate-status.mjs';
import { applyLabel, postComment } from './lib/github-api.mjs';
import { executePrReview } from './lib/execute-review.mjs';
import { executeIssueReview } from './lib/issue-review.mjs';
import { loadConfig, resolveBotLogin } from './lib/review-config.mjs';
import { requestIssueReview, requestPrReview } from './lib/request-review.mjs';
import { resolveThread } from './lib/resolve-thread.mjs';
import { scaffoldGate } from './lib/scaffold-gate.mjs';

const execFileAsync = promisify(execFile);

// process.execPath may be the copilot binary, not node. Find real node.
const NODE_BIN = (() => {
  try {
    return execFileSync('which', ['node'], { encoding: 'utf8' }).trim() || 'node';
  } catch {
    return 'node';
  }
})();

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = join(__dirname, 'lib');
const REPO_ROOT = resolveRepoRoot(__dirname);
const REVIEWS_DIR = join(REPO_ROOT, '.squad', 'reviews');
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
    if (existsSync(join(candidate, 'package.json')) && existsSync(join(candidate, '.squad'))) {
      return candidate;
    }
  }

  return join(startDir, '..', '..', '..');
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

function jsonHandler(fn) {
  return async (params = {}) => {
    try {
      const result = await fn(params);
      return JSON.stringify(result, null, 2);
    } catch (error) {
      return JSON.stringify({ error: normalizeError(error) }, null, 2);
    }
  };
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
      message: 'Run squad_reviews_setup to create .squad/reviews/config.json from the template.',
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
      message: '.squad/reviews/config.json already exists. Use squad_reviews_init --force to overwrite.',
    };
  }

  copyFileSync(CONFIG_TEMPLATE_PATH, CONFIG_PATH);

  return {
    created: true,
    configPath: CONFIG_PATH,
    copiedFrom: CONFIG_TEMPLATE_PATH,
    nextSteps: [
      'Edit .squad/reviews/config.json to map role slugs to your team agents.',
      'Run squad_reviews_scaffold_gate to generate CI workflows.',
    ],
  };
}

const session = await joinSession({
  onPermissionRequest: approveAll,
  tools: [
    {
      name: 'squad_reviews_request_pr_review',
      description: 'Request a PR review from a configured Squad reviewer role.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          pr: { type: 'number' },
          reviewer: { type: 'string' },
          owner: { type: 'string' },
          repo: { type: 'string' },
        },
        required: ['pr', 'reviewer', 'owner', 'repo'],
      },
      handler: jsonHandler(({ pr, reviewer, owner, repo }) =>
        requestPrReview(REPO_ROOT, { pr, reviewer, owner, repo })
      ),
    },
    {
      name: 'squad_reviews_execute_pr_review',
      description: 'Execute a PR review using the configured reviewer charter and GitHub bot token. Validates review quality before posting. Call squad_identity_resolve_token first to get the token.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          pr: { type: 'number' },
          roleSlug: { type: 'string' },
          event: { type: 'string', enum: ['COMMENT', 'REQUEST_CHANGES', 'APPROVE'] },
          reviewBody: { type: 'string', description: 'Main review body (min 150 words, must cite file:line references).' },
          comments: {
            type: 'array',
            description: 'Inline review comments attached to specific lines. Use suggestion blocks for proposed fixes.',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'File path relative to repo root.' },
                line: { type: 'number', description: 'Line number for single-line comment (or end line for multi-line).' },
                start_line: { type: 'number', description: 'Start line for multi-line comment (omit for single-line).' },
                side: { type: 'string', enum: ['LEFT', 'RIGHT'], description: 'Side of diff. Default: RIGHT.' },
                body: {
                  type: 'string',
                  description: 'Comment body. Use ```suggestion\\n...\\n``` blocks for native change suggestions.',
                },
              },
              required: ['path', 'line', 'body'],
            },
          },
          token: { type: 'string', description: 'GitHub token for this role (from squad_identity_resolve_token). Required.' },
          owner: { type: 'string' },
          repo: { type: 'string' },
        },
        required: ['pr', 'roleSlug', 'event', 'token', 'owner', 'repo'],
      },
      handler: jsonHandler(({ pr, roleSlug, event, reviewBody, comments, token, owner, repo }) => {
        if (!token) throw new Error('token is required. Call squad_identity_resolve_token first.');
        return executePrReview(REPO_ROOT, token, { pr, roleSlug, event, reviewBody, comments, owner, repo });
      }),
    },
    {
      name: 'squad_reviews_acknowledge_feedback',
      description: 'List unresolved PR review threads that must be addressed or dismissed. Call squad_identity_resolve_token first.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          pr: { type: 'number' },
          token: { type: 'string', description: 'GitHub token (from squad_identity_resolve_token). Required.' },
          owner: { type: 'string' },
          repo: { type: 'string' },
        },
        required: ['pr', 'token', 'owner', 'repo'],
      },
      handler: jsonHandler(({ pr, token, owner, repo }) => {
        if (!token) throw new Error('token is required. Call squad_identity_resolve_token first.');
        return acknowledgeFeedback(REPO_ROOT, token, { pr, owner, repo });
      }),
    },
    {
      name: 'squad_reviews_resolve_thread',
      description: 'Reply to a PR review thread, then resolve it as addressed or dismissed. Call squad_identity_resolve_token first.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          pr: { type: 'number' },
          threadId: { type: 'string' },
          commentId: { type: 'string' },
          reply: { type: 'string' },
          action: { type: 'string', enum: ['addressed', 'dismissed'] },
          token: { type: 'string', description: 'GitHub token (from squad_identity_resolve_token). Required.' },
          owner: { type: 'string' },
          repo: { type: 'string' },
        },
        required: ['pr', 'threadId', 'commentId', 'reply', 'action', 'token', 'owner', 'repo'],
      },
      handler: jsonHandler(({ pr, threadId, commentId, reply, action, token, owner, repo }) => {
        if (!token) throw new Error('token is required. Call squad_identity_resolve_token first.');
        return resolveThread(REPO_ROOT, token, {
          pr,
          threadId,
          commentId: normalizeCommentId(commentId),
          reply,
          action,
          owner,
          repo,
        });
      }),
    },
    {
      name: 'squad_reviews_request_issue_review',
      description: 'Request an issue review from a configured Squad reviewer role.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          issue: { type: 'number' },
          reviewer: { type: 'string' },
          owner: { type: 'string' },
          repo: { type: 'string' },
        },
        required: ['issue', 'reviewer', 'owner', 'repo'],
      },
      handler: jsonHandler(({ issue, reviewer, owner, repo }) =>
        requestIssueReview(REPO_ROOT, { issue, reviewer, owner, repo })
      ),
    },
    {
      name: 'squad_reviews_execute_issue_review',
      description: 'Execute an issue review and optionally apply the approval label. Call squad_identity_resolve_token first to get the token.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          issue: { type: 'number' },
          roleSlug: { type: 'string' },
          reviewBody: { type: 'string' },
          approved: { type: 'boolean' },
          token: { type: 'string', description: 'GitHub token for this role (from squad_identity_resolve_token). Required.' },
          owner: { type: 'string' },
          repo: { type: 'string' },
        },
        required: ['issue', 'roleSlug', 'reviewBody', 'approved', 'token', 'owner', 'repo'],
      },
      handler: jsonHandler(({ issue, roleSlug, reviewBody, approved, token, owner, repo }) => {
        if (!token) throw new Error('token is required. Call squad_identity_resolve_token first.');
        return executeIssueReview(REPO_ROOT, token, { issue, roleSlug, reviewBody, approved, owner, repo });
      }),
    },
    {
      name: 'squad_reviews_status',
      description: 'Show the current Squad review configuration and registered reviewers.',
      skipPermission: true,
      parameters: { type: 'object', properties: {}, required: [] },
      handler: jsonHandler(() => getStatusSummary()),
    },
    {
      name: 'squad_reviews_doctor',
      description: 'Run health checks for the Squad review extension setup.',
      skipPermission: true,
      parameters: { type: 'object', properties: {}, required: [] },
      handler: jsonHandler(() => runDoctor()),
    },
    {
      name: 'squad_reviews_setup',
      description: 'Create .squad/reviews/config.json from the template if it does not already exist. For the full guided setup flow, use the CLI: squad-reviews setup',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          force: {
            type: 'boolean',
            description: 'Overwrite existing config if present.',
          },
        },
        required: [],
      },
      handler: jsonHandler(({ force }) => {
        if (force && existsSync(CONFIG_TEMPLATE_PATH)) {
          mkdirSync(REVIEWS_DIR, { recursive: true });
          copyFileSync(CONFIG_TEMPLATE_PATH, CONFIG_PATH);
          return { created: true, configPath: CONFIG_PATH, overwritten: true };
        }
        return setupConfig();
      }),
    },
    {
      name: 'squad_reviews_init',
      description: 'Install squad-reviews extension files, SKILL.md, and config template into the target repo. File-only install — no network calls.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'Target repo root. Defaults to current repo root.',
          },
        },
        required: [],
      },
      handler: jsonHandler(async ({ target }) => {
        const { spawnSync } = await import('node:child_process');
        const cliPath = join(LIB_DIR, '..', '..', '..', 'bin', 'squad-reviews.mjs');
        const args = ['init', '--json'];
        if (target) args.push('--target', target);
        const result = spawnSync(NODE_BIN, [cliPath, ...args], {
          cwd: REPO_ROOT,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (result.error) throw new Error(result.error.message);
        if (result.status !== 0) throw new Error((result.stderr || 'init failed').trim());
        try { return JSON.parse(result.stdout); } catch { return { initialized: true, output: result.stdout }; }
      }),
    },
    {
      name: 'squad_reviews_scaffold_gate',
      description: 'Scaffold review gate CI workflows (reusable + caller) for the configured reviewer roles.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          roles: {
            type: 'array',
            items: { type: 'string' },
            description: 'Reviewer role slugs to require. Defaults to all roles from config.',
          },
          dryRun: {
            type: 'boolean',
            description: 'If true, return generated content without writing files.',
          },
        },
        required: [],
      },
      handler: jsonHandler(({ roles, dryRun }) => scaffoldGate(REPO_ROOT, { roles, dryRun })),
    },
    {
      name: 'squad_reviews_gate_status',
      description: 'Check review gate status for a PR. Returns which roles have approved, which are pending, and unresolved thread count. Call squad_identity_resolve_token first.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          pr: { type: 'number', description: 'Pull request number' },
          token: { type: 'string', description: 'GitHub token (from squad_identity_resolve_token). Required.' },
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          roles: {
            type: 'array',
            items: { type: 'string' },
            description: 'Roles to check. Defaults to all from config.',
          },
        },
        required: ['pr', 'token', 'owner', 'repo'],
      },
      handler: jsonHandler(({ pr, token, owner, repo, roles }) => {
        if (!token) throw new Error('token is required. Call squad_identity_resolve_token first.');
        return checkGateStatus(REPO_ROOT, token, { pr, owner, repo, roles });
      }),
    },
    // ─── Generate Config Tool ───────────────────────────────────────────────────
    {
      name: 'squad_reviews_generate_config',
      description: 'Generate a .squad/reviews/config.json scaffold from squad-identity config. Only infers deterministic fields; uses placeholders for ambiguous ones.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          roles: {
            type: 'array',
            items: { type: 'string' },
            description: 'Roles to include. Defaults to all roles from squad-identity config.',
          },
        },
        required: [],
      },
      handler: jsonHandler(({ roles: requestedRoles } = {}) => {
        const identityPath = join(REPO_ROOT, '.squad', 'identity', 'config.json');
        if (!existsSync(identityPath)) {
          throw new Error('squad-identity not configured. Run squad_identity_init first.');
        }
        const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
        const allRoles = Object.keys(identity.apps || {});
        const selectedRoles = requestedRoles && requestedRoles.length > 0
          ? requestedRoles.filter(r => allRoles.includes(r))
          : allRoles;

        if (selectedRoles.length === 0) {
          throw new Error(`No matching roles found. Available: ${allRoles.join(', ')}`);
        }

        const reviewers = {};
        const agentNameMap = identity.agentNameMap || {};
        const reverseMap = Object.fromEntries(
          Object.entries(agentNameMap).map(([agent, role]) => [role, agent])
        );

        for (const role of selectedRoles) {
          const agent = reverseMap[role] || 'AGENT_NAME';
          reviewers[role] = {
            agent,
            dimension: 'TODO: describe review dimension',
            charterPath: `.squad/agents/${agent}/charter.md`,
            gateRule: { required: 'always' },
          };
        }

        const config = {
          schemaVersion: '1.1.0',
          reviewers,
          threadResolution: {
            requireReplyBeforeResolve: true,
            templates: {
              addressed: 'Addressed in {sha}: {description}',
              dismissed: 'Dismissed: {justification}',
            },
          },
          feedbackSources: ['squad-agents', 'humans', 'github-copilot-bot'],
        };

        return { config, note: 'Edit dimension and gateRule fields for each role before committing.' };
      }),
    },
    // ─── Coordinator Tools ──────────────────────────────────────────────────────
    {
      name: 'squad_reviews_dispatch_review',
      description: 'Request a review from a specific role on a PR. Applies a label and posts a comment to notify the reviewer agent. Call squad_identity_resolve_token first.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          pr: { type: 'number', description: 'Pull request number' },
          role: { type: 'string', description: 'Reviewer role slug (e.g., "codereview", "security")' },
          token: { type: 'string', description: 'GitHub token (from squad_identity_resolve_token). Required.' },
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          message: { type: 'string', description: 'Optional message to include in the dispatch comment.' },
        },
        required: ['pr', 'role', 'token', 'owner', 'repo'],
      },
      handler: jsonHandler(async ({ pr, role, token, owner, repo, message }) => {
        if (!token) throw new Error('token is required. Call squad_identity_resolve_token first.');

        const config = loadConfig(REPO_ROOT);
        if (!config.reviewers[role]) {
          const available = Object.keys(config.reviewers).join(', ');
          throw new Error(`Role "${role}" not found in config. Available: ${available}`);
        }

        const label = `review:${role}:requested`;
        await applyLabel(token, owner, repo, pr, label);

        const agent = config.reviewers[role].agent;
        const body = [
          `🔍 **Review requested**: @${agent} (${role})`,
          message ? `\n${message}` : '',
          `\n_Dispatched by coordinator._`,
        ].join('');
        await postComment(token, owner, repo, pr, body);

        return { dispatched: true, pr, role, agent, label };
      }),
    },
    {
      name: 'squad_reviews_blocked_prs',
      description: 'List PRs that are blocked on pending reviews. Queries GitHub for open PRs with review:*:requested labels. Call squad_identity_resolve_token first.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          token: { type: 'string', description: 'GitHub token (from squad_identity_resolve_token). Required.' },
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
          role: { type: 'string', description: 'Filter by specific role. Omit for all roles.' },
        },
        required: ['token', 'owner', 'repo'],
      },
      handler: jsonHandler(async ({ token, owner, repo, role }) => {
        if (!token) throw new Error('token is required. Call squad_identity_resolve_token first.');

        const labelQuery = role
          ? `label:"review:${role}:requested"`
          : 'label:review';
        const query = `repo:${owner}/${repo} is:pr is:open ${labelQuery}`;
        const url = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=50`;

        const response = await fetch(url, {
          headers: buildGitHubHeaders(token),
        });
        if (!response.ok) {
          const body = await response.text();
          throw new Error(`GitHub search failed (${response.status}): ${body}`);
        }

        const data = await response.json();
        const prs = data.items.map(item => ({
          number: item.number,
          title: item.title,
          author: item.user?.login,
          labels: item.labels.map(l => l.name).filter(n => n.startsWith('review:')),
          url: item.html_url,
          createdAt: item.created_at,
        }));

        return { count: prs.length, prs };
      }),
    },
    {
      name: 'squad_reviews_pending_reviews',
      description: 'For a given PR, show which reviewer roles still need to approve and which have approved. Reuses the gate-status evaluator. Call squad_identity_resolve_token first.',
      skipPermission: true,
      parameters: {
        type: 'object',
        properties: {
          pr: { type: 'number', description: 'Pull request number' },
          token: { type: 'string', description: 'GitHub token (from squad_identity_resolve_token). Required.' },
          owner: { type: 'string', description: 'Repository owner' },
          repo: { type: 'string', description: 'Repository name' },
        },
        required: ['pr', 'token', 'owner', 'repo'],
      },
      handler: jsonHandler(async ({ pr, token, owner, repo }) => {
        if (!token) throw new Error('token is required. Call squad_identity_resolve_token first.');
        const status = await checkGateStatus(REPO_ROOT, token, { pr, owner, repo });
        return {
          pr,
          passed: status.passed,
          approvedRoles: status.approvedRoles,
          pendingRoles: status.pendingRoles,
          unresolvedThreads: status.unresolvedThreads,
          summary: status.summary,
        };
      }),
    },
  ],
});
