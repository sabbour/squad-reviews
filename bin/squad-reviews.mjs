#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { access, copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { acknowledgeFeedback } from '../extensions/squad-reviews/lib/acknowledge-feedback.mjs';
import { appendAuditEntry } from '../extensions/squad-reviews/lib/audit-log.mjs';
import { checkGateStatus } from '../extensions/squad-reviews/lib/gate-status.mjs';
import { executePrReview } from '../extensions/squad-reviews/lib/execute-review.mjs';
import { executeIssueReview } from '../extensions/squad-reviews/lib/issue-review.mjs';
import { loadConfig, SCHEMA_VERSION } from '../extensions/squad-reviews/lib/review-config.mjs';
import { requestIssueReview, requestPrReview } from '../extensions/squad-reviews/lib/request-review.mjs';
import { resolveThread } from '../extensions/squad-reviews/lib/resolve-thread.mjs';
import { scaffoldGate } from '../extensions/squad-reviews/lib/scaffold-gate.mjs';
import { updateCopilotInstructions, readInstalledReviewsVersion } from '../extensions/squad-reviews/lib/copilot-instructions.mjs';

const COMMANDS = {
  setup: 'Full guided setup (recommended)',
  init: 'Install files only (advanced)',
  'generate-config': 'Generate .squad/reviews/config.json from squad-identity',
  status: 'Show config summary',
  doctor: 'Run health checks',
  upgrade: 'Upgrade this CLI to the latest version',
  'scaffold-gate': 'Scaffold review gate CI workflows',
  'gate-status': 'Check review gate status for a PR',
  report: 'Show review metrics and status for recent PRs',
  'request-pr-review': 'Request PR review',
  'execute-pr-review': 'Execute PR review',
  'acknowledge-feedback': 'List unresolved review feedback',
  'resolve-thread': 'Reply to and resolve a review thread',
  'request-issue-review': 'Request issue review',
  'execute-issue-review': 'Execute issue review',
};

const COMMAND_USAGE = {
  setup: 'squad-reviews setup [target-repo] [--force] [--json]',
  init: 'squad-reviews init [target-repo] [--json]',
  'generate-config': 'squad-reviews generate-config [--roles <role1,role2,...>] [--force] [--json]',
  status: 'squad-reviews status [--json]',
  doctor: 'squad-reviews doctor [--json]',
  upgrade: 'squad-reviews upgrade',
  'scaffold-gate': 'squad-reviews scaffold-gate [--roles <role1,role2,...>] [--dry-run] [--json]',
  'gate-status': 'squad-reviews gate-status --pr <number> [--roles <role1,role2,...>] [--owner <owner> --repo <repo>]',
  report: 'squad-reviews report [--owner <owner> --repo <repo>]',
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
const CONFIG_RELATIVE_PATH = join('.squad', 'reviews', 'config.json');
const TEMPLATE_RELATIVE_PATH = join('.squad', 'reviews', 'config.json.template');
const ACTIONS = new Set(['addressed', 'dismissed']);
const REVIEW_EVENTS = new Set(['COMMENT', 'REQUEST_CHANGES', 'APPROVE']);
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const NPX_CACHE_PATTERN = /(^|[\\/])_npx([\\/]|$)/;

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Write human-readable progress to stderr (never pollutes JSON on stdout). */
function log(msg) {
  process.stderr.write(`${msg}\n`);
}

function printDoctorReport(result) {
  log(`\nsquad-reviews doctor`);
  log(`  repo: ${result.repoRoot}`);
  log(``);
  for (const check of result.checks) {
    const icon = check.warn ? '⚠' : check.ok ? '✓' : '✗';
    log(`  ${icon} ${check.name}: ${check.details}`);
  }
  log(``);
  log(result.ok ? `✅ All checks passed.` : `✗ Some checks failed.`);
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

  // Try `gh auth token` as fallback (user has gh CLI authenticated)
  try {
    const result = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    const ghToken = result.trim();
    if (ghToken) {
      return { token: ghToken, source: 'gh auth token' };
    }
  } catch {
    // gh not installed or not authenticated — continue
  }

  if (required) {
    throw new Error(`Missing GitHub token; set one of ${TOKEN_ENV_VARS.join(', ')} or authenticate with \`gh auth login\``);
  }

  return {
    token: null,
    source: null,
  };
}

/**
 * Resolve a token for a specific reviewer role via squad-identity CLI.
 * Falls back to generic env var token if squad-identity is unavailable.
 * @param {string} roleSlug - reviewer role slug
 * @returns {{ token: string, source: string }}
 */
function resolveRoleTokenCli(roleSlug) {
  // Per-role env var first (e.g., SQUAD_REVIEW_TOKEN_SECURITY)
  const roleEnvKey = `SQUAD_REVIEW_TOKEN_${roleSlug.toUpperCase().replace(/-/g, '_')}`;
  if (process.env[roleEnvKey]) {
    return { token: process.env[roleEnvKey].trim(), source: roleEnvKey };
  }

  // Try squad-identity CLI to resolve per-role token
  try {
    const repoRoot = findRepoRoot();
    const result = spawnSync('squad-identity', ['resolve-token', '--role', roleSlug], {
      cwd: repoRoot,
      timeout: 15_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const token = result?.stdout?.trim();
    if (token && result.status === 0) {
      return { token, source: `squad-identity (${roleSlug})` };
    }
  } catch {
    // squad-identity not available — fall through
  }

  // Fall back to generic token
  return resolveToken(true);
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

function detectInstallMode(packageRootPath) {
  const hints = [packageRootPath, process.argv[1] ?? '', process.env.npm_execpath ?? ''];
  if (hints.some((hint) => NPX_CACHE_PATTERN.test(hint)) || process.env.npm_command === 'exec') {
    return 'npx';
  }

  return 'global';
}

function getLatestPackageVersion(packageName) {
  return execFileSync(NPM_COMMAND, ['view', packageName, 'version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function getGlobalInstalledPackageVersion(packageName) {
  const globalRoot = execFileSync(NPM_COMMAND, ['root', '-g'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  const packageJsonPath = join(globalRoot, ...packageName.split('/'), 'package.json');
  return JSON.parse(readFileSync(packageJsonPath, 'utf8')).version;
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
      ok: true, // Token is optional for local dev — agents resolve at runtime via squad_identity_resolve_token
      warn: !token.token,
      details: token.token
        ? token.source
        : `No token available (authenticate with \`gh auth login\` or set ${TOKEN_ENV_VARS.join(', ')})`,
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

  // copilot-instructions.md managed block
  const instrPath = join(repoRoot, '.github', 'copilot-instructions.md');
  if (existsSync(instrPath)) {
    const installedVersion = readInstalledReviewsVersion(repoRoot);
    const hasBlock = installedVersion !== null
      || /<!--\s*squad-reviews:\s*start(?:\s+v[^\s>-]+)?\s*-->/.test(readFileSync(instrPath, 'utf-8'));
    checks.push({
      name: 'copilot-instructions',
      ok: hasBlock,
      warn: !hasBlock,
      details: hasBlock
        ? installedVersion
          ? `squad-reviews block present (v${installedVersion})`
          : 'squad-reviews block present (legacy, no version stamp — re-run setup)'
        : 'Missing squad-reviews block — run `squad-reviews setup`',
    });
  } else {
    checks.push({
      name: 'copilot-instructions',
      ok: false,
      warn: true,
      details: 'No .github/copilot-instructions.md — run `squad-reviews setup`',
    });
  }

  // Review gate workflow
  const gateWorkflow = join(repoRoot, '.github', 'workflows', 'squad-review-gate.yml');
  const gateOk = existsSync(gateWorkflow);
  checks.push({
    name: 'gate-workflow',
    ok: gateOk,
    warn: !gateOk,
    details: gateOk
      ? '.github/workflows/squad-review-gate.yml present'
      : 'Missing review-gate workflow — run `squad-reviews setup` (or `scaffold-gate`)',
  });

  // Installed extension files
  const extDir = join(repoRoot, '.copilot', 'extensions', 'squad-reviews');
  const extEntry = join(extDir, 'extension.mjs');
  const extOk = existsSync(extEntry);
  checks.push({
    name: 'extension',
    ok: extOk,
    warn: !extOk,
    details: extOk
      ? '.copilot/extensions/squad-reviews/ installed'
      : 'Missing .copilot/extensions/squad-reviews/extension.mjs — run `squad-reviews setup`',
  });

  // Installed skill
  const skillFile = join(repoRoot, '.copilot', 'skills', 'squad-reviews', 'SKILL.md');
  const skillOk = existsSync(skillFile);
  checks.push({
    name: 'skill',
    ok: skillOk,
    warn: !skillOk,
    details: skillOk
      ? '.copilot/skills/squad-reviews/SKILL.md installed'
      : 'Missing .copilot/skills/squad-reviews/SKILL.md — run `squad-reviews setup`',
  });

  return {
    ok: checks.every((check) => check.ok || check.warn),
    repoRoot,
    checks,
  };
}

/**
 * Canonical Copilot CLI install locations for project-scoped artifacts.
 * - Extension: .copilot/extensions/{name}/extension.mjs (Copilot CLI extension discovery convention)
 * - Skill:     .copilot/skills/{name}/SKILL.md           (Copilot-level skill / coordinator playbook)
 *
 * Earlier versions of `squad-reviews setup` mistakenly wrote to
 * `.github/extensions/squad-reviews/` and `.squad/skills/squad-reviews/`, which
 * the Copilot CLI never picks up and which the doctor (correctly) ignored.
 * This helper installs to the canonical locations and cleans up any stale
 * artifacts left behind at the legacy paths.
 */
async function installExtensionAndSkill(packageRoot, target) {
  const { readdirSync, copyFileSync } = await import('node:fs');

  const extSrcDir = join(packageRoot, 'extensions', 'squad-reviews');
  const extDestDir = join(target, '.copilot', 'extensions', 'squad-reviews');
  const skillSrc = join(packageRoot, 'SKILL.md');
  const skillDestDir = join(target, '.copilot', 'skills', 'squad-reviews');

  // Migration: clean up legacy install paths used by squad-reviews <= 1.5.2.
  // We log every removal so the operation is never silently destructive.
  const legacyExtDir = join(target, '.github', 'extensions', 'squad-reviews');
  const legacySkillDir = join(target, '.squad', 'skills', 'squad-reviews');
  if (existsSync(legacyExtDir)) {
    await rm(legacyExtDir, { recursive: true, force: true });
    log(`  🧹 Removed legacy extension at ${legacyExtDir}`);
  }
  if (existsSync(legacySkillDir)) {
    await rm(legacySkillDir, { recursive: true, force: true });
    log(`  🧹 Removed legacy skill at ${legacySkillDir}`);
  }

  // Install extension to canonical location.
  await mkdir(join(extDestDir, 'lib'), { recursive: true });
  if (existsSync(extSrcDir)) {
    const extFiles = readdirSync(extSrcDir).filter((f) => f.endsWith('.mjs'));
    for (const file of extFiles) {
      copyFileSync(join(extSrcDir, file), join(extDestDir, file));
    }
    const libDir = join(extSrcDir, 'lib');
    if (existsSync(libDir)) {
      const libFiles = readdirSync(libDir).filter((f) => f.endsWith('.mjs'));
      for (const file of libFiles) {
        copyFileSync(join(libDir, file), join(extDestDir, 'lib', file));
      }
    }
    log(`  ✓ Extension → ${extDestDir}`);
  }

  // Install SKILL.md to canonical location.
  await mkdir(skillDestDir, { recursive: true });
  if (existsSync(skillSrc)) {
    copyFileSync(skillSrc, join(skillDestDir, 'SKILL.md'));
    log(`  ✓ SKILL.md → ${join(skillDestDir, 'SKILL.md')}`);
  }

  return { extDestDir, skillDestDir };
}

async function commandSetup(values) {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(__dirname, '..');
  const target = values?.target ? resolve(values.target) : findRepoRoot();

  log(`\n━━━ Phase 1: Initialize ━━━\n`);

  // Create reviews directory and copy template
  const reviewsDir = join(target, '.squad', 'reviews');
  const templateSrc = join(packageRoot, 'reviews', 'config.json.template');
  const templateDest = join(target, '.squad', 'reviews', 'config.json.template');
  const configDest = join(target, '.squad', 'reviews', 'config.json');

  await mkdir(reviewsDir, { recursive: true });

  if (existsSync(templateSrc)) {
    await copyFile(templateSrc, templateDest);
    log(`  ✓ Template → ${templateDest}`);
  }

  if ((!existsSync(configDest) || values?.force) && existsSync(templateDest)) {
    await copyFile(templateDest, configDest);
    log(`  ✓ Config created → ${configDest}`);
  } else if (existsSync(configDest)) {
    log(`  ⏭ Config already exists — skipping (use --force to overwrite)`);
  }

  // Install extension + skill to canonical Copilot CLI locations
  // (.copilot/extensions/squad-reviews/, .copilot/skills/squad-reviews/SKILL.md),
  // cleaning up any legacy paths from older versions.
  const { extDestDir, skillDestDir } = await installExtensionAndSkill(packageRoot, target);

  log(`\n━━━ Phase 2: Labels ━━━\n`);

  const labelsCreated = [];
  try {
    const { token, source } = resolveToken(false);
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
            if (response.ok) {
              labelsCreated.push(label);
              log(`  ✓ Created: ${label}`);
            } else if (response.status === 422) {
              labelsCreated.push(label);
              log(`  ✓ Exists: ${label}`);
            } else {
              log(`  ⚠ Failed to create ${label} (${response.status})`);
              if (response.status === 404 || response.status === 403) {
                log(`    → Token may not have access to ${github.owner}/${github.repo}.`);
                log(`    → Try: gh auth login --hostname github.com --git-protocol https`);
                log(`    → Or set GH_TOKEN with a PAT that has repo access.`);
                break; // Don't repeat the same error for every label
              }
            }
          } catch (e) {
            log(`  ⚠ Failed to create ${label}: ${e.message}`);
          }
        }
      } else {
        log(`  ⏭ No GitHub remote detected — skipping label creation`);
      }
    } else if (!token) {
      log(`  ⏭ No token — skipping label creation`);
    } else {
      log(`  ⏭ No config — skipping label creation`);
    }
  } catch (e) {
    log(`  ⚠ Label creation failed: ${e.message}`);
  }

  log(`\n━━━ Phase 3: Review Gate ━━━\n`);

  let gateResult = null;
  try {
    if (existsSync(configDest)) {
      gateResult = scaffoldGate(target, { roles: [] });
      log(`  ✓ Gate workflows scaffolded`);
    }
  } catch (e) {
    log(`  ⏭ Skipped: ${e.message}`);
  }

  log(`\n━━━ Phase 4: Coordinator Instructions ━━━\n`);

  let instructionsResult = null;
  try {
    instructionsResult = updateCopilotInstructions(target);
    log(`  ✓ ${instructionsResult.action} squad-reviews block in ${instructionsResult.path}`);
    const { previousVersion: prev, newVersion: next } = instructionsResult;
    if (next) {
      if (prev && prev !== next) {
        log(`    Block version: v${prev} → v${next}`);
      } else if (prev && prev === next) {
        log(`    Block version: v${next} (unchanged)`);
      } else {
        log(`    Block version: v${next}`);
      }
    }
  } catch (e) {
    log(`  ⚠ Could not update copilot-instructions.md: ${e.message}`);
  }

  log(`\n━━━ Phase 5: Health Check ━━━\n`);

  const doctorResult = await commandDoctor();
  for (const check of doctorResult.checks) {
    const icon = check.warn ? '⚠' : check.ok ? '✓' : '✗';
    log(`  ${icon} ${check.name}: ${check.details}`);
  }

  // Note: commandDoctor returns ok=true even when there are warnings (a warn is
  // considered "non-fatal but not clean"). For the setup summary we want the
  // strict definition: every check must be ok && !warn.
  const warnCount = doctorResult.checks.filter((c) => c.warn).length;
  const failCount = doctorResult.checks.filter((c) => !c.ok && !c.warn).length;
  const setupOk = warnCount === 0 && failCount === 0;

  if (setupOk) {
    log(`\n✅ squad-reviews setup complete.`);
  } else {
    log(`\n⚠️  squad-reviews setup completed with ${warnCount} warning(s)${failCount ? ` and ${failCount} failure(s)` : ''} — see Phase 5 above.`);
    log(`   Address the issues above, then re-run \`squad-reviews doctor\` to verify.`);
  }
  log(`\nNext steps:`);
  log(`  1. In a Copilot CLI session, call squad_reviews_generate_config`);
  log(`     to scaffold .squad/reviews/config.json from your squad-identity config.`);
  log(`     Then edit dimensions and gate rules for each role.`);
  log(`  2. Commit all generated files.`);
  log(`  3. Set the Review Gate as a required status check in branch protection.`);

  if (!setupOk) {
    // Non-zero exit so CI / scripts can detect that setup did not fully succeed.
    process.exitCode = 1;
  }

  return {
    initialized: true,
    ok: setupOk,
    target,
    files: {
      config: configDest,
      extension: extDestDir,
      skill: join(skillDestDir, 'SKILL.md'),
    },
    labelsCreated,
    gateScaffolded: gateResult?.scaffolded || false,
    copilotInstructions: instructionsResult,
    doctor: doctorResult,
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
  const roleSlug = normalizeNonEmptyString(values.role, 'role');
  const { token } = resolveRoleTokenCli(roleSlug);

  return executePrReview(repoRoot, token, {
    pr: normalizePositiveInteger(values.pr, 'pr'),
    roleSlug,
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
  const roleSlug = normalizeNonEmptyString(values.role, 'role');
  const { token } = resolveRoleTokenCli(roleSlug);

  return executeIssueReview(repoRoot, token, {
    issue: normalizePositiveInteger(values.issue, 'issue'),
    roleSlug,
    reviewBody: values.body,
    approved: values.approved === true,
    owner: github.owner,
    repo: github.repo,
  });
}

async function commandUpgrade() {
  const packageName = '@sabbour/squad-reviews';
  const packageJsonUrl = new URL('../package.json', import.meta.url);
  const packageRootPath = fileURLToPath(new URL('..', import.meta.url));
  const currentVersion = JSON.parse(readFileSync(packageJsonUrl, 'utf8')).version;
  const installMode = detectInstallMode(packageRootPath);

  log(`Current version: ${currentVersion}`);

  if (installMode === 'npx') {
    const latestVersion = getLatestPackageVersion(packageName);
    if (latestVersion === currentVersion) {
      log(`✅ Already on latest (${currentVersion}) via npx.`);
    } else {
      log(`⬆️  Update available: ${currentVersion} → ${latestVersion}`);
      log(`Re-run with: npx ${packageName}@latest upgrade`);
    }
    return;
  }

  log(`Upgrading ${packageName}...`);

  try {
    execFileSync(NPM_COMMAND, ['install', '-g', `${packageName}@latest`], { stdio: 'inherit' });
    const newVersion = getGlobalInstalledPackageVersion(packageName);
    if (newVersion === currentVersion) {
      log(`✅ Already on latest: ${newVersion}`);
    } else {
      log(`✅ Upgraded ${packageName}: ${currentVersion} → ${newVersion}`);
    }
    log(`ℹ️  Re-run \`${packageName.split('/').pop()} setup\` in each target repo to pick up new template/instruction changes.`);
  } catch {
    throw new Error(`Upgrade failed. Try manually: npm install -g ${packageName}@latest`);
  }
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
  const target = values?.target ? resolve(values.target) : findRepoRoot();

  log(`🔧 Installing squad-reviews into: ${target}\n`);

  // Create reviews directory and copy template
  const reviewsDir = join(target, '.squad', 'reviews');
  const templateSrc = join(packageRoot, 'reviews', 'config.json.template');
  const templateDest = join(target, '.squad', 'reviews', 'config.json.template');

  await mkdir(reviewsDir, { recursive: true });

  if (existsSync(templateSrc)) {
    await copyFile(templateSrc, templateDest);
    log(`  ✓ Template → ${templateDest}`);
  }

  // Install extension + skill to canonical Copilot CLI locations,
  // cleaning up any legacy paths from older versions.
  const { extDestDir, skillDestDir } = await installExtensionAndSkill(packageRoot, target);

  log(`\n✅ Files installed. Run \`squad-reviews setup\` for the full guided flow.`);

  return {
    initialized: true,
    target,
    files: {
      template: templateDest,
      extension: extDestDir,
      skill: join(skillDestDir, 'SKILL.md'),
    },
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
  const auditPath = join(repoRoot, '.squad', 'reviews', 'audit.jsonl');
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

async function commandGenerateConfig(values) {
  const repoRoot = findRepoRoot();
  const identityPath = join(repoRoot, '.squad', 'identity', 'config.json');

  if (!existsSync(identityPath)) {
    throw new Error('squad-identity not configured. Run squad-identity setup first.');
  }

  const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
  const allRoles = Object.keys(identity.apps || {});
  const selectedRoles = values.roles
    ? values.roles.split(',').map(r => r.trim()).filter(r => allRoles.includes(r))
    : allRoles;

  if (selectedRoles.length === 0) {
    throw new Error(`No matching roles found. Available: ${allRoles.join(', ')}`);
  }

  // Build reviewers section from identity
  const agentNameMap = identity.agentNameMap || {};
  const reverseMap = Object.fromEntries(
    Object.entries(agentNameMap).map(([agent, role]) => [role, agent])
  );

  const reviewers = {};
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

  const configPath = join(repoRoot, '.squad', 'reviews', 'config.json');
  if (existsSync(configPath) && !values.force) {
    throw new Error(`${configPath} already exists. Use --force to overwrite.`);
  }

  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(join(repoRoot, '.squad', 'reviews'), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');

  log(`✓ Generated ${configPath}`);
  log(`  Roles: ${selectedRoles.join(', ')}`);
  log(`  Edit "dimension" and "gateRule" fields before committing.`);

  return { config, path: configPath, note: 'Edit dimension and gateRule fields for each role before committing.' };
}

const COMMAND_HANDLERS = {
  setup: {
    options: {
      target: { type: 'string' },
      force: { type: 'boolean' },
    },
    handler: commandSetup,
  },
  init: {
    options: {
      target: { type: 'string' },
    },
    handler: commandInit,
  },
  'generate-config': {
    options: {
      roles: { type: 'string' },
      force: { type: 'boolean' },
    },
    handler: commandGenerateConfig,
  },
  status: {
    options: {},
    handler: commandStatus,
  },
  doctor: {
    options: {},
    handler: commandDoctor,
  },
  upgrade: {
    options: {},
    handler: commandUpgrade,
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
  // Extract global --json flag before command parsing
  const jsonFlag = argv.includes('--json');
  const filteredArgv = argv.filter(a => a !== '--json');

  const [commandName, ...restArgs] = filteredArgv;

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

  // Human-facing commands (setup, init, doctor) only emit JSON with --json
  const humanCommands = new Set(['setup', 'init', 'doctor']);
  if (result != null && (jsonFlag || !humanCommands.has(commandName))) {
    printJson(result);
  } else if (commandName === 'doctor' && result != null) {
    printDoctorReport(result);
  }
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
