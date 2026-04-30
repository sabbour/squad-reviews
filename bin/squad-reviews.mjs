#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { access, copyFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { acknowledgeFeedback } from '../extensions/squad-reviews/lib/acknowledge-feedback.mjs';
import { appendAuditEntry } from '../extensions/squad-reviews/lib/audit-log.mjs';
import { checkGateStatus } from '../extensions/squad-reviews/lib/gate-status.mjs';
import { executePrReview } from '../extensions/squad-reviews/lib/execute-review.mjs';
import { executeIssueReview } from '../extensions/squad-reviews/lib/issue-review.mjs';
import { loadConfig, migrateConfig, LATEST_SCHEMA_VERSION } from '../extensions/squad-reviews/lib/review-config.mjs';
import { requestIssueReview, requestPrReview } from '../extensions/squad-reviews/lib/request-review.mjs';
import { resolveThread } from '../extensions/squad-reviews/lib/resolve-thread.mjs';
import { scaffoldGate } from '../extensions/squad-reviews/lib/scaffold-gate.mjs';

const COMMANDS = {
  init: 'Install squad-reviews into a repo (one-command setup)',
  status: 'Show config summary',
  doctor: 'Health check',
  setup: 'Copy template to reviews/config.json',
  'scaffold-gate': 'Scaffold review gate CI workflows',
  'gate-status': 'Check review gate status for a PR',
  report: 'Show review metrics and status for recent PRs',
  migrate: 'Migrate config to latest schema version',
  'request-pr-review': 'Request PR review',
  'execute-pr-review': 'Execute PR review',
  'acknowledge-feedback': 'List unresolved review feedback',
  'resolve-thread': 'Reply to and resolve a review thread',
  'request-issue-review': 'Request issue review',
  'execute-issue-review': 'Execute issue review',
};

const COMMAND_USAGE = {
  init: 'squad-reviews init [target-repo]',
  status: 'squad-reviews status',
  doctor: 'squad-reviews doctor',
  setup: 'squad-reviews setup',
  'scaffold-gate': 'squad-reviews scaffold-gate [--roles <role1,role2,...>] [--dry-run]',
  'gate-status': 'squad-reviews gate-status --pr <number> [--roles <role1,role2,...>] [--owner <owner> --repo <repo>]',
  report: 'squad-reviews report [--owner <owner> --repo <repo>]',
  migrate: 'squad-reviews migrate',
  'request-pr-review': 'squad-reviews request-pr-review --pr <number> --reviewer <role> [--owner <owner> --repo <repo>]',
  'execute-pr-review': 'squad-reviews execute-pr-review --pr <number> --role <role> --event <COMMENT|REQUEST_CHANGES|APPROVE> [--body <text>] [--owner <owner> --repo <repo>]',
  'acknowledge-feedback': 'squad-reviews acknowledge-feedback --pr <number> [--owner <owner> --repo <repo>]',
  'resolve-thread': 'squad-reviews resolve-thread --pr <number> --thread <id> --comment <id> --reply <text> --action <addressed|dismissed> [--owner <owner> --repo <repo>]',
  'request-issue-review': 'squad-reviews request-issue-review --issue <number> --reviewer <role> [--owner <owner> --repo <repo>]',
  'execute-issue-review': 'squad-reviews execute-issue-review --issue <number> --role <role> [--approved] [--body <text>] [--owner <owner> --repo <repo>]',
};

const SHARED_REPO_OPTIONS = {
  owner: { type: 'string' },
  repo: { type: 'string' },
};

const TOKEN_ENV_VARS = ['SQUAD_REVIEW_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'];
const CONFIG_RELATIVE_PATH = join('reviews', 'config.json');
const TEMPLATE_RELATIVE_PATH = join('reviews', 'config.json.template');
const ACTIONS = new Set(['addressed', 'dismissed']);
const REVIEW_EVENTS = new Set(['COMMENT', 'REQUEST_CHANGES', 'APPROVE']);

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp(commandName) {
  if (commandName && COMMAND_USAGE[commandName]) {
    process.stdout.write(`${COMMAND_USAGE[commandName]}\n`);
    return;
  }

  const lines = [
    'Usage: squad-reviews <command> [options]',
    '',
    'Commands:',
    ...Object.entries(COMMANDS).map(([name, description]) => `  ${name.padEnd(24)} ${description}`),
    '',
    'Run squad-reviews <command> --help for command-specific usage.',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

function normalizeNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return value.trim();
}

function normalizePositiveInteger(value, fieldName) {
  const number = Number(value);

  if (!Number.isInteger(number) || number <= 0) {
    throw new Error(`${fieldName} must be a positive integer`);
  }

  return number;
}

function ensureAllowedValue(value, allowedValues, fieldName) {
  const normalizedValue = normalizeNonEmptyString(value, fieldName);
  if (!allowedValues.has(normalizedValue)) {
    throw new Error(`${fieldName} must be one of: ${Array.from(allowedValues).join(', ')}`);
  }

  return normalizedValue;
}

function parseCommandArgs(args, options = {}, { allowPositionals = false } = {}) {
  return parseArgs({
    args,
    allowPositionals,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      ...options,
    },
  });
}

function findRepoRoot(startDir = process.cwd()) {
  let currentDir = resolve(startDir);

  while (true) {
    if (existsSync(join(currentDir, CONFIG_RELATIVE_PATH)) || existsSync(join(currentDir, '.git'))) {
      return currentDir;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Unable to resolve repo root from ${startDir}`);
    }

    currentDir = parentDir;
  }
}

function parseGitHubRemote(remoteUrl) {
  if (typeof remoteUrl !== 'string' || remoteUrl.trim() === '') {
    return null;
  }

  const trimmedRemoteUrl = remoteUrl.trim();

  try {
    const parsedUrl = new URL(trimmedRemoteUrl);
    if (parsedUrl.hostname === 'github.com') {
      const match = parsedUrl.pathname.match(/^\/(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?\/?$/);
      if (match?.groups) {
        return {
          owner: match.groups.owner,
          repo: match.groups.repo,
          source: 'git-origin',
          remoteUrl: trimmedRemoteUrl,
        };
      }
    }
  } catch {
    // Fall back to SSH-style parsing.
  }

  const match = trimmedRemoteUrl.match(/github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/);
  if (!match?.groups) {
    return null;
  }

  return {
    owner: match.groups.owner,
    repo: match.groups.repo,
    source: 'git-origin',
    remoteUrl: trimmedRemoteUrl,
  };
}

function getOriginRemoteUrl(repoRoot) {
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function resolveRepoCoordinates(repoRoot, { owner, repo, required = false } = {}) {
  const normalizedOwner = owner?.trim() ? owner.trim() : null;
  const normalizedRepo = repo?.trim() ? repo.trim() : null;
  const detectedRemote = parseGitHubRemote(getOriginRemoteUrl(repoRoot));

  const resolvedOwner = normalizedOwner ?? detectedRemote?.owner ?? null;
  const resolvedRepo = normalizedRepo ?? detectedRemote?.repo ?? null;

  if (required && (!resolvedOwner || !resolvedRepo)) {
    throw new Error('owner and repo are required; pass --owner/--repo or configure git origin');
  }

  return {
    owner: resolvedOwner,
    repo: resolvedRepo,
    source:
      normalizedOwner && normalizedRepo
        ? 'cli'
        : detectedRemote && (!normalizedOwner || !normalizedRepo)
          ? detectedRemote.source
          : normalizedOwner || normalizedRepo
            ? 'mixed'
            : null,
    remoteUrl: detectedRemote?.remoteUrl ?? null,
  };
}

function resolveToken(required = false) {
  for (const envVar of TOKEN_ENV_VARS) {
    const value = process.env[envVar];
    if (typeof value === 'string' && value.trim() !== '') {
      return {
        token: value.trim(),
        source: envVar,
      };
    }
  }

  // Try auto-resolving via squad-identity if available
  try {
    const identityLib = join(findRepoRoot(), '.github', 'extensions', 'squad-identity', 'lib', 'resolve-token.mjs');
    if (existsSync(identityLib)) {
      // squad-identity is installed — hint to the user
      if (required) {
        throw new Error(
          `Missing GitHub token; set one of ${TOKEN_ENV_VARS.join(', ')} or use squad_identity_resolve_token tool`
        );
      }
    }
  } catch (e) {
    if (required && e.message.includes('Missing GitHub token')) throw e;
  }

  if (required) {
    throw new Error(`Missing GitHub token; set one of ${TOKEN_ENV_VARS.join(', ')}`);
  }

  return {
    token: null,
    source: null,
  };
}

function inspectConfig(repoRoot) {
  const configPath = join(repoRoot, CONFIG_RELATIVE_PATH);
  const summary = {
    path: configPath,
    exists: existsSync(configPath),
    valid: false,
    schemaVersion: null,
    reviewerCount: 0,
    reviewers: [],
    feedbackSources: [],
    threadResolution: null,
    error: null,
  };

  if (!summary.exists) {
    summary.error = `Config not found at ${configPath}`;
    return summary;
  }

  try {
    const config = loadConfig(repoRoot);
    summary.valid = true;
    summary.schemaVersion = config.schemaVersion;
    summary.reviewers = Object.entries(config.reviewers).map(([role, reviewer]) => ({
      role,
      agent: reviewer.agent,
      dimension: reviewer.dimension,
      charterPath: reviewer.charterPath,
    }));
    summary.reviewerCount = summary.reviewers.length;
    summary.feedbackSources = [...config.feedbackSources];
    summary.threadResolution = {
      requireReplyBeforeResolve: config.threadResolution.requireReplyBeforeResolve,
    };
  } catch (error) {
    summary.error = error instanceof Error ? error.message : String(error);
  }

  return summary;
}

async function commandStatus() {
  const repoRoot = findRepoRoot();
  const config = inspectConfig(repoRoot);
  const token = resolveToken(false);
  const github = resolveRepoCoordinates(repoRoot);

  return {
    repoRoot,
    config,
    github: {
      owner: github.owner,
      repo: github.repo,
      source: github.source,
      remoteUrl: github.remoteUrl,
    },
    token: {
      present: Boolean(token.token),
      source: token.source,
    },
  };
}

async function commandDoctor() {
  const repoRoot = findRepoRoot();
  const config = inspectConfig(repoRoot);
  const token = resolveToken(false);
  const github = resolveRepoCoordinates(repoRoot);

  const checks = [
    {
      name: 'repoRoot',
      ok: true,
      details: repoRoot,
    },
    {
      name: 'config',
      ok: config.valid,
      details: config.valid ? `${config.reviewerCount} reviewers loaded` : config.error,
    },
    {
      name: 'gitOrigin',
      ok: Boolean(github.owner && github.repo),
      details: github.owner && github.repo ? `${github.owner}/${github.repo}` : 'GitHub origin not detected',
    },
    {
      name: 'token',
      ok: Boolean(token.token),
      details: token.token ? token.source : `Set one of ${TOKEN_ENV_VARS.join(', ')}`,
    },
  ];

  if (config.valid) {
    const missingCharters = config.reviewers
      .map((reviewer) => reviewer.charterPath)
      .filter((charterPath) => !existsSync(join(repoRoot, charterPath)));

    checks.push({
      name: 'charters',
      ok: missingCharters.length === 0,
      details:
        missingCharters.length === 0
          ? 'All charter paths exist'
          : `Missing: ${missingCharters.join(', ')}`,
    });
  }

  return {
    ok: checks.every((check) => check.ok),
    repoRoot,
    checks,
  };
}

async function commandSetup() {
  const repoRoot = findRepoRoot();
  const templatePath = join(repoRoot, TEMPLATE_RELATIVE_PATH);
  const configPath = join(repoRoot, CONFIG_RELATIVE_PATH);

  await access(templatePath);
  if (existsSync(configPath)) {
    throw new Error(`Config already exists at ${configPath}`);
  }

  await mkdir(dirname(configPath), { recursive: true });
  await copyFile(templatePath, configPath);

  // Create labels for reviewer roles
  const labelsCreated = [];
  try {
    const { token } = resolveToken(false);
    if (token) {
      const config = loadConfig(repoRoot);
      const github = resolveRepoCoordinates(repoRoot, { required: false });
      if (github.owner && github.repo) {
        for (const role of Object.keys(config.reviewers)) {
          const label = `${role}:approved`;
          try {
            const response = await fetch(
              `https://api.github.com/repos/${github.owner}/${github.repo}/labels`,
              {
                method: 'POST',
                headers: {
                  Accept: 'application/vnd.github+json',
                  Authorization: `token ${token}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ name: label, color: '0e8a16', description: `Approved by ${role} reviewer` }),
              }
            );
            if (response.ok || response.status === 422) {
              labelsCreated.push(label);
            }
          } catch { /* best effort */ }
        }
      }
    }
  } catch { /* labels are best-effort */ }

  return {
    created: true,
    repoRoot,
    templatePath,
    configPath,
    labelsCreated,
  };
}

async function commandRequestPrReview(values) {
  const repoRoot = findRepoRoot();
  const github = resolveRepoCoordinates(repoRoot, {
    owner: values.owner,
    repo: values.repo,
    required: true,
  });

  return requestPrReview(repoRoot, {
    pr: normalizePositiveInteger(values.pr, 'pr'),
    reviewer: normalizeNonEmptyString(values.reviewer, 'reviewer'),
    owner: github.owner,
    repo: github.repo,
  });
}

async function commandExecutePrReview(values) {
  const repoRoot = findRepoRoot();
  const github = resolveRepoCoordinates(repoRoot, {
    owner: values.owner,
    repo: values.repo,
    required: true,
  });
  const { token } = resolveToken(true);

  return executePrReview(repoRoot, token, {
    pr: normalizePositiveInteger(values.pr, 'pr'),
    roleSlug: normalizeNonEmptyString(values.role, 'role'),
    event: ensureAllowedValue(values.event, REVIEW_EVENTS, 'event'),
    reviewBody: values.body,
    owner: github.owner,
    repo: github.repo,
  });
}

async function commandAcknowledgeFeedback(values) {
  const repoRoot = findRepoRoot();
  const github = resolveRepoCoordinates(repoRoot, {
    owner: values.owner,
    repo: values.repo,
    required: true,
  });
  const { token } = resolveToken(true);

  return acknowledgeFeedback(repoRoot, token, {
    pr: normalizePositiveInteger(values.pr, 'pr'),
    owner: github.owner,
    repo: github.repo,
  });
}

async function commandResolveThread(values) {
  const repoRoot = findRepoRoot();
  const github = resolveRepoCoordinates(repoRoot, {
    owner: values.owner,
    repo: values.repo,
    required: true,
  });
  const { token } = resolveToken(true);

  return resolveThread(repoRoot, token, {
    pr: normalizePositiveInteger(values.pr, 'pr'),
    threadId: normalizeNonEmptyString(values.thread, 'thread'),
    commentId: normalizePositiveInteger(values.comment, 'comment'),
    reply: normalizeNonEmptyString(values.reply, 'reply'),
    action: ensureAllowedValue(values.action, ACTIONS, 'action'),
    owner: github.owner,
    repo: github.repo,
  });
}

async function commandRequestIssueReview(values) {
  const repoRoot = findRepoRoot();
  const github = resolveRepoCoordinates(repoRoot, {
    owner: values.owner,
    repo: values.repo,
    required: true,
  });

  return requestIssueReview(repoRoot, {
    issue: normalizePositiveInteger(values.issue, 'issue'),
    reviewer: normalizeNonEmptyString(values.reviewer, 'reviewer'),
    owner: github.owner,
    repo: github.repo,
  });
}

async function commandExecuteIssueReview(values) {
  const repoRoot = findRepoRoot();
  const github = resolveRepoCoordinates(repoRoot, {
    owner: values.owner,
    repo: values.repo,
    required: true,
  });
  const { token } = resolveToken(true);

  return executeIssueReview(repoRoot, token, {
    issue: normalizePositiveInteger(values.issue, 'issue'),
    roleSlug: normalizeNonEmptyString(values.role, 'role'),
    reviewBody: values.body,
    approved: values.approved === true,
    owner: github.owner,
    repo: github.repo,
  });
}

async function commandScaffoldGate(values) {
  const repoRoot = findRepoRoot();
  const roles = values.roles
    ? values.roles.split(',').map(r => r.trim()).filter(Boolean)
    : [];
  const dryRun = values['dry-run'] === true;

  return scaffoldGate(repoRoot, { roles, dryRun });
}

async function commandGateStatus(values) {
  const repoRoot = findRepoRoot();
  const github = resolveRepoCoordinates(repoRoot, {
    owner: values.owner,
    repo: values.repo,
    required: true,
  });
  const { token } = resolveToken(true);
  const roles = values.roles
    ? values.roles.split(',').map(r => r.trim()).filter(Boolean)
    : [];

  return checkGateStatus(repoRoot, token, {
    pr: normalizePositiveInteger(values.pr, 'pr'),
    owner: github.owner,
    repo: github.repo,
    roles,
  });
}

async function commandInit(values) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(__dirname, '..');
  const target = values.target ? resolve(values.target) : findRepoRoot();

  // Create reviews directory and copy template
  const reviewsDir = join(target, 'reviews');
  const templateSrc = join(packageRoot, 'reviews', 'config.json.template');
  const templateDest = join(target, 'reviews', 'config.json.template');
  const configDest = join(target, 'reviews', 'config.json');

  await mkdir(reviewsDir, { recursive: true });

  if (existsSync(templateSrc)) {
    await copyFile(templateSrc, templateDest);
  }

  // Copy config from template if it doesn't exist
  if (!existsSync(configDest) && existsSync(templateDest)) {
    await copyFile(templateDest, configDest);
  }

  // Install extension
  const extSrcDir = join(packageRoot, 'extensions', 'squad-reviews');
  const extDestDir = join(target, '.github', 'extensions', 'squad-reviews');
  await mkdir(join(extDestDir, 'lib'), { recursive: true });

  // Copy extension files
  const { readdirSync, copyFileSync } = await import('node:fs');
  if (existsSync(extSrcDir)) {
    const extFiles = readdirSync(extSrcDir).filter(f => f.endsWith('.mjs'));
    for (const file of extFiles) {
      copyFileSync(join(extSrcDir, file), join(extDestDir, file));
    }
    const libDir = join(extSrcDir, 'lib');
    if (existsSync(libDir)) {
      const libFiles = readdirSync(libDir).filter(f => f.endsWith('.mjs'));
      for (const file of libFiles) {
        copyFileSync(join(libDir, file), join(extDestDir, 'lib', file));
      }
    }
  }

  // Install SKILL.md
  const skillSrc = join(packageRoot, 'squad-reviews', 'SKILL.md');
  const skillDestDir = join(target, '.squad', 'skills', 'squad-reviews');
  await mkdir(skillDestDir, { recursive: true });
  if (existsSync(skillSrc)) {
    copyFileSync(skillSrc, join(skillDestDir, 'SKILL.md'));
  }

  // Create labels if token and repo are available
  const labelsCreated = [];
  try {
    const { token } = resolveToken(false);
    if (token && existsSync(configDest)) {
      const config = loadConfig(target);
      const github = resolveRepoCoordinates(target, { required: false });
      if (github.owner && github.repo) {
        for (const role of Object.keys(config.reviewers)) {
          const label = `${role}:approved`;
          try {
            const response = await fetch(
              `https://api.github.com/repos/${github.owner}/${github.repo}/labels`,
              {
                method: 'POST',
                headers: {
                  Accept: 'application/vnd.github+json',
                  Authorization: `token ${token}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ name: label, color: '0e8a16', description: `Approved by ${role} reviewer` }),
              }
            );
            if (response.ok || response.status === 422) {
              labelsCreated.push(label);
            }
          } catch { /* best effort */ }
        }
      }
    }
  } catch { /* labels are best-effort */ }

  // Scaffold gate workflows
  let gateResult = null;
  try {
    if (existsSync(configDest)) {
      gateResult = scaffoldGate(target, { roles: [] });
    }
  } catch { /* gate scaffold is best-effort */ }

  return {
    initialized: true,
    target,
    files: {
      config: configDest,
      extension: extDestDir,
      skill: join(skillDestDir, 'SKILL.md'),
    },
    labelsCreated,
    gateScaffolded: gateResult?.scaffolded || false,
    nextSteps: [
      'Edit reviews/config.json to map role slugs to your team agents.',
      'Commit all generated files.',
      'Set the Review Gate as a required status check in branch protection.',
    ],
  };
}

async function commandReport(values) {
  const repoRoot = findRepoRoot();
  const github = resolveRepoCoordinates(repoRoot, {
    owner: values.owner,
    repo: values.repo,
    required: true,
  });
  const { token } = resolveToken(true);
  const config = loadConfig(repoRoot);
  const roles = Object.keys(config.reviewers);

  // Fetch open PRs
  const prsResponse = await fetch(
    `https://api.github.com/repos/${github.owner}/${github.repo}/pulls?state=open&per_page=20`,
    { headers: { Accept: 'application/vnd.github+json', Authorization: `token ${token}` } }
  );
  if (!prsResponse.ok) {
    throw new Error(`Failed to fetch PRs: ${prsResponse.status}`);
  }
  const prs = await prsResponse.json();

  // For each PR, check gate status
  const prStatuses = [];
  for (const pr of prs.slice(0, 10)) {
    try {
      const status = await checkGateStatus(repoRoot, token, {
        pr: pr.number,
        owner: github.owner,
        repo: github.repo,
        roles,
      });
      prStatuses.push({
        number: pr.number,
        title: pr.title,
        author: pr.user?.login,
        passed: status.passed,
        approvedRoles: status.approvedRoles,
        pendingRoles: status.pendingRoles,
        unresolvedThreads: status.unresolvedThreads,
      });
    } catch { /* skip PRs with errors */ }
  }

  // Read audit log for metrics
  const auditPath = join(repoRoot, 'reviews', 'audit.jsonl');
  let recentActions = [];
  if (existsSync(auditPath)) {
    const lines = readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean);
    recentActions = lines.slice(-50).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  }

  return {
    owner: github.owner,
    repo: github.repo,
    openPrs: prs.length,
    prStatuses,
    recentAuditActions: recentActions.length,
    roles,
    summary: {
      totalChecked: prStatuses.length,
      allPassed: prStatuses.filter(p => p.passed).length,
      pendingApprovals: prStatuses.filter(p => !p.passed).length,
    },
  };
}

async function commandMigrate() {
  const repoRoot = findRepoRoot();
  const configPath = join(repoRoot, CONFIG_RELATIVE_PATH);

  if (!existsSync(configPath)) {
    throw new Error(`Config not found at ${configPath}. Run 'squad-reviews setup' first.`);
  }

  const rawConfig = JSON.parse(readFileSync(configPath, 'utf8'));
  const result = migrateConfig(rawConfig);

  if (!result.migrated) {
    return {
      migrated: false,
      version: result.config.schemaVersion,
      message: `Config is already at latest version (${result.toVersion}).`,
    };
  }

  writeFileSync(configPath, JSON.stringify(result.config, null, 2) + '\n', 'utf8');

  return {
    migrated: true,
    fromVersion: result.fromVersion,
    toVersion: result.toVersion,
    configPath,
    message: `Migrated config from ${result.fromVersion} to ${result.toVersion}.`,
  };
}

const COMMAND_HANDLERS = {
  init: {
    options: {
      target: { type: 'string' },
    },
    handler: commandInit,
  },
  status: {
    options: {},
    handler: commandStatus,
  },
  doctor: {
    options: {},
    handler: commandDoctor,
  },
  setup: {
    options: {},
    handler: commandSetup,
  },
  'scaffold-gate': {
    options: {
      roles: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
    handler: commandScaffoldGate,
  },
  'gate-status': {
    options: {
      pr: { type: 'string' },
      roles: { type: 'string' },
      ...SHARED_REPO_OPTIONS,
    },
    handler: commandGateStatus,
  },
  report: {
    options: {
      ...SHARED_REPO_OPTIONS,
    },
    handler: commandReport,
  },
  migrate: {
    options: {},
    handler: commandMigrate,
  },
  'request-pr-review': {
    options: {
      pr: { type: 'string' },
      reviewer: { type: 'string' },
      ...SHARED_REPO_OPTIONS,
    },
    handler: commandRequestPrReview,
  },
  'execute-pr-review': {
    options: {
      pr: { type: 'string' },
      role: { type: 'string' },
      event: { type: 'string' },
      body: { type: 'string' },
      ...SHARED_REPO_OPTIONS,
    },
    handler: commandExecutePrReview,
  },
  'acknowledge-feedback': {
    options: {
      pr: { type: 'string' },
      ...SHARED_REPO_OPTIONS,
    },
    handler: commandAcknowledgeFeedback,
  },
  'resolve-thread': {
    options: {
      pr: { type: 'string' },
      thread: { type: 'string' },
      comment: { type: 'string' },
      reply: { type: 'string' },
      action: { type: 'string' },
      ...SHARED_REPO_OPTIONS,
    },
    handler: commandResolveThread,
  },
  'request-issue-review': {
    options: {
      issue: { type: 'string' },
      reviewer: { type: 'string' },
      ...SHARED_REPO_OPTIONS,
    },
    handler: commandRequestIssueReview,
  },
  'execute-issue-review': {
    options: {
      issue: { type: 'string' },
      role: { type: 'string' },
      approved: { type: 'boolean' },
      body: { type: 'string' },
      ...SHARED_REPO_OPTIONS,
    },
    handler: commandExecuteIssueReview,
  },
};

async function main(argv = process.argv.slice(2)) {
  const [commandName, ...restArgs] = argv;

  if (!commandName || commandName === '--help' || commandName === '-h') {
    printHelp();
    return;
  }

  if (commandName === 'help') {
    const parsed = parseCommandArgs(restArgs, {}, { allowPositionals: true });
    printHelp(parsed.positionals[0]);
    return;
  }

  const command = COMMAND_HANDLERS[commandName];
  if (!command) {
    throw new Error(`Unknown command: ${commandName}`);
  }

  const parsed = parseCommandArgs(restArgs, command.options);
  if (parsed.values.help) {
    printHelp(commandName);
    return;
  }

  const result = await command.handler(parsed.values);
  printJson(result);
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
