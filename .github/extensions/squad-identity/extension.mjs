/**
 * squad-identity extension for GitHub Copilot CLI
 *
 * Registers identity management tools. Tools call lib/*.mjs directly.
 * on session start so Squad bot agents can call scripts without knowing paths.
 *
 * @see https://github.com/github/copilot-sdk
 */

import { joinSession } from '@github/copilot-sdk/extension';
import {
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB_DIR   = join(__dirname, 'lib');

// Resolve REPO_ROOT by walking up from extension dir (.github/extensions/squad-identity/)
const REPO_ROOT   = join(__dirname, '..', '..', '..');
const CONFIGURE   = join(LIB_DIR, 'configure-identity.mjs');

// ---------------------------------------------------------------------------
// Helper: run configure-identity.mjs with a flag, return stdout
// ---------------------------------------------------------------------------

async function runConfigure(session, flag) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [CONFIGURE, flag],
      { cwd: REPO_ROOT, timeout: 30000 }
    );
    if (stderr) session.log(stderr);
    return stdout;
  } catch (err) {
    const msg = err.stdout || err.stderr || err.message;
    session.log(`configure-identity ${flag} error: ${msg}`);
    return msg;
  }
}

const ROLE_PATTERNS = [
  { slug: 'security', keywords: ['security', 'auth', 'compliance'] },
  { slug: 'frontend', keywords: ['frontend', 'ui', 'design'] },
  { slug: 'backend', keywords: ['backend', 'api', 'server'] },
  { slug: 'tester', keywords: ['test', 'qa', 'quality'] },
  { slug: 'codereview', keywords: ['code review', 'reviewer', 'review'] },
  { slug: 'scribe', keywords: ['scribe'] },
  { slug: 'devops', keywords: ['devops', 'infra', 'platform'] },
  { slug: 'docs', keywords: ['docs', 'devrel', 'writer'] },
  { slug: 'data', keywords: ['data', 'database', 'analytics'] },
  { slug: 'lead', keywords: ['lead', 'architect', 'tech lead'] },
];

function normalizeRoleKey(roleKey) {
  if (typeof roleKey !== 'string') return null;
  const normalized = roleKey
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || null;
}

function stripMarkdownCell(value) {
  return value
    .replace(/`/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseMarkdownRow(line) {
  if (!line.trim().startsWith('|')) return [];
  return line
    .trim()
    .slice(1, -1)
    .split('|')
    .map(cell => stripMarkdownCell(cell.trim()));
}

function parseTeamRoster(projectRoot) {
  const teamPath = join(projectRoot, '.squad', 'team.md');

  try {
    const lines = readFileSync(teamPath, 'utf8').split(/\r?\n/);
    const membersIndex = lines.findIndex(line => /^##\s+Members\b/i.test(line.trim()));
    if (membersIndex === -1) return [];

    let headerIndex = -1;
    for (let index = membersIndex + 1; index < lines.length - 1; index += 1) {
      if (
        lines[index].trim().startsWith('|') &&
        /^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(lines[index + 1])
      ) {
        headerIndex = index;
        break;
      }
      if (index > membersIndex + 1 && /^##\s+/.test(lines[index].trim())) {
        break;
      }
    }

    if (headerIndex === -1) return [];

    const headers = parseMarkdownRow(lines[headerIndex]).map(header => normalizeRoleKey(header));
    const nameIndex = headers.indexOf('name');
    const roleIndex = headers.indexOf('role');
    if (nameIndex === -1 || roleIndex === -1) return [];

    const roster = [];
    for (let index = headerIndex + 2; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      if (!line.startsWith('|')) break;

      const cells = parseMarkdownRow(lines[index]);
      const name = cells[nameIndex];
      const role = cells[roleIndex];
      if (name && role) {
        roster.push({ name, role });
      }
    }

    return roster;
  } catch {
    return [];
  }
}

function matchRolePattern(role) {
  const roleText = typeof role === 'string' ? role.toLowerCase() : '';
  let bestMatch = null;

  for (const [priority, pattern] of ROLE_PATTERNS.entries()) {
    const hits = pattern.keywords.filter(keyword => roleText.includes(keyword)).length;
    if (!hits) continue;

    if (
      !bestMatch ||
      hits > bestMatch.hits ||
      (hits === bestMatch.hits && priority < bestMatch.priority)
    ) {
      bestMatch = { slug: pattern.slug, hits, priority };
    }
  }

  return bestMatch?.slug ?? null;
}

function discoverTeamRoleSlugs(projectRoot) {
  const roles = [];
  const seen = new Set();

  for (const member of parseTeamRoster(projectRoot)) {
    const role = matchRolePattern(member.role) ?? normalizeRoleKey(member.role);
    if (!role || seen.has(role)) continue;
    seen.add(role);
    roles.push(role);
  }

  return roles;
}

function loadAppRegistrations(projectRoot) {
  const appsDir = join(projectRoot, '.squad', 'identity', 'apps');
  const registrations = new Map();

  if (!existsSync(appsDir)) return registrations;

  for (const file of readdirSync(appsDir)) {
    if (!file.endsWith('.json')) continue;
    const role = file.replace(/\.json$/, '');
    try {
      const data = JSON.parse(readFileSync(join(appsDir, file), 'utf8'));
      registrations.set(role, data);
    } catch {
      // Skip unreadable registrations.
    }
  }

  return registrations;
}

function normalizeRequestedRoles(roles) {
  if (!Array.isArray(roles) || roles.length === 0) return null;

  const normalizedRoles = [];
  const seen = new Set();

  for (const role of roles) {
    const normalizedRole = matchRolePattern(role) ?? normalizeRoleKey(role);
    if (!normalizedRole || seen.has(normalizedRole)) continue;
    seen.add(normalizedRole);
    normalizedRoles.push(normalizedRole);
  }

  return normalizedRoles;
}

function buildCreateScript(roles) {
  const roleList = roles.length ? roles.join(', ') : 'none';
  const lines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    '# Squad Identity — create missing GitHub Apps for team roles.',
    '# Review before running. This checks prerequisites, then creates apps sequentially.',
    '# Each create-app command opens a browser and must finish before the next one starts.',
    ...(roles.length
      ? roles.map(role => `# - ${role}`)
      : ['# No missing app registrations were found for the selected roles.']),
    '',
    'node --version >/dev/null',
    'gh auth status >/dev/null',
    '',
    `echo "Roles queued for app creation: ${roleList}"`,
  ];

  if (roles.length) {
    for (const role of roles) {
      lines.push('', `echo "Creating GitHub App for role: ${role}"`, `squad-identity create-app --role ${role}`);
    }
  } else {
    lines.push('', 'echo "No GitHub Apps need creation."');
  }

  lines.push('', 'echo "Running squad-identity doctor..."', 'squad-identity doctor', '');
  return lines.join('\n');
}

function buildInstallScript(apps) {
  const appList = apps.length
    ? apps.map(app => `${app.role} (${app.slug})`).join(', ')
    : 'none';
  const lines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    '# Squad Identity — install registered GitHub Apps into the current repository.',
    '# Review before running. This opens each install page, waits for manual confirmation,',
    '# then runs squad-identity setup so installation IDs can be captured.',
    ...(apps.length
      ? apps.map(app => `# - ${app.role} -> ${app.slug}`)
      : ['# No registered apps are missing installation IDs for the selected roles.']),
    '',
    'gh auth status >/dev/null',
    '',
    `echo "Apps queued for installation: ${appList}"`,
  ];

  if (apps.length) {
    for (const app of apps) {
      lines.push(
        '',
        `echo "Opening install page for ${app.role} (${app.slug})"`,
        `gh browse "https://github.com/apps/${app.slug}/installations/new"`,
        `read -r -p "After completing the browser install for ${app.slug}, press Enter to continue..." _`
      );
    }

    lines.push('', 'echo "Running squad-identity setup to capture installation IDs..."', 'squad-identity setup');
  } else {
    lines.push('', 'echo "No GitHub App installs are pending."');
  }

  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

joinSession(async session => {

  // -------------------------------------------------------------------------
  // Tool: squad_identity_doctor
  // -------------------------------------------------------------------------

  session.registerTool({
    name: 'squad_identity_doctor',
    description: 'Run a health check on the Squad identity setup: verifies config.json exists, agentNameMap is populated, PEM keys are readable, resolve-token.mjs is accessible, and token resolution succeeds for the lead role.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const out = await runConfigure(session, '--doctor');
      return { type: 'text', text: out || 'No output.' };
    },
  });

  // -------------------------------------------------------------------------
  // Tool: squad_identity_configure
  // -------------------------------------------------------------------------

  session.registerTool({
    name: 'squad_identity_configure',
    description: 'Update agent charters with ROLE_SLUG and refresh the identity block in copilot-instructions.md. Runs both update-charters and update-copilot-instructions. Idempotent.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      const charterResult = await runConfigure(session, '--update-charters');
      const instructionsResult = await runConfigure(session, '--update-copilot-instructions');
      return {
        type: 'text',
        text: `Charters:\n${charterResult}\n\nCopilot Instructions:\n${instructionsResult}`,
      };
    },
  });

  // -------------------------------------------------------------------------
  // Tool: squad_identity_setup (GUIDED SETUP)
  // -------------------------------------------------------------------------

  session.registerTool({
    name: 'squad_identity_setup',
    description: 'Run the full guided setup: init, discover roles, create/import apps, install, configure, and health check. Requires user interaction (browser).',
    inputSchema: { type: 'object', properties: {}, required: [] },
    handler: async () => {
      try {
        // Show current status first
        const out = await runConfigure(session, '--status');

        const instructions = [
          '🚀 To run full guided setup, use the CLI in your terminal:',
          '',
          '  squad-identity setup',
          '',
          'This will:',
          '1. Read .squad/team.md to discover roles',
          '2. Show roles and ask for confirmation',
          '3. Create a GitHub App per role (opens browser)',
          '4. Install all apps into the repository',
          '5. Capture installation IDs',
          '6. Update charters with ROLE_SLUG',
          '',
          'Current status:',
          out?.trim() || '(no configuration found — run setup first)',
        ].join('\n');

        return { type: 'text', text: instructions };
      } catch (err) {
        return { type: 'text', text: `❌ Setup check failed: ${err.message}\n\nRun \`squad-identity setup\` in your terminal to start the guided flow.` };
      }
    },
  });

  // -------------------------------------------------------------------------
  // Tool: squad_identity_resolve_token (AGENT RUNTIME)
  // -------------------------------------------------------------------------

  session.registerTool({
    name: 'squad_identity_resolve_token',
    description: 'Resolve bot GitHub App token for the current agent. Derives ROLE_SLUG from charter, looks up app ID, signs JWT with private key, and exchanges for installation access token. Returns token or error.',
    inputSchema: {
      type: 'object',
      properties: {
        roleSlug: {
          type: 'string',
          description: 'Optional: explicit role slug (e.g., "backend"). If omitted, derives from charter ROLE_SLUG.',
        },
      },
      required: [],
    },
    handler: async (input) => {
      try {
        const resolveScript = join(LIB_DIR, 'resolve-token.mjs');
        const roleSlug = input.roleSlug || process.env.ROLE_SLUG || '';
        
        const { stdout, stderr } = await execFileAsync(
          process.execPath,
          [resolveScript, roleSlug],
          { cwd: REPO_ROOT, timeout: 10000 }
        );
        
        if (stderr) session.log(`[squad-identity] resolve-token stderr: ${stderr}`);
        
        if (!stdout || !stdout.trim()) {
          return { type: 'text', text: '❌ Could not resolve token. Check squad_identity_doctor for diagnostics.' };
        }
        
        return { type: 'text', text: `✅ Token resolved:\n${stdout.trim()}` };
      } catch (err) {
        const msg = err.stderr || err.message || 'unknown error';
        return { type: 'text', text: `❌ Token resolution failed: ${msg}` };
      }
    },
  });

  // -------------------------------------------------------------------------
  // Tool: squad_identity_rotate_key (KEY ROTATION)
  // -------------------------------------------------------------------------

  session.registerTool({
    name: 'squad_identity_rotate_key',
    description: 'Rotate a GitHub App private key for a role. Opens the GitHub App settings page so the user can generate a new key, then imports the downloaded PEM into the OS keychain. Guided two-step flow.',
    inputSchema: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          description: 'Role slug to rotate key for (e.g., "backend", "frontend", "lead").',
        },
        pemPath: {
          type: 'string',
          description: 'Optional: path to the already-downloaded PEM file. If provided, skips the browser step and imports directly.',
        },
      },
      required: ['role'],
    },
    handler: async (input) => {
      try {
        const createAppScript = join(LIB_DIR, 'create-app.mjs');

        if (input.pemPath) {
          // Direct import — user already has the PEM file
          const { stdout, stderr } = await execFileAsync(
            process.execPath,
            [createAppScript, '--import-key', input.pemPath, '--role', input.role],
            { cwd: REPO_ROOT, timeout: 15000 }
          );
          if (stderr) session.log(`[squad-identity] rotate-key stderr: ${stderr}`);
          return { type: 'text', text: stdout?.trim() || '✅ Key rotated and stored in OS keychain.' };
        }

        // Step 1: Open settings page so user can generate a new key
        const { stdout, stderr } = await execFileAsync(
          process.execPath,
          [createAppScript, '--generate-key', '--role', input.role, '--owner', 'placeholder'],
          { cwd: REPO_ROOT, timeout: 15000 }
        );
        if (stderr) session.log(`[squad-identity] rotate-key stderr: ${stderr}`);

        const instructions = [
          stdout?.trim() || '',
          '',
          '📋 Next steps:',
          '1. In the browser, click "Generate a private key" to create a new key',
          '2. Download the PEM file',
          `3. Run: squad_identity_rotate_key with role="${input.role}" and pemPath="~/Downloads/<app-slug>*.pem"`,
          '4. Delete the old key from the GitHub App settings page',
        ].join('\n');

        return { type: 'text', text: instructions };
      } catch (err) {
        const msg = err.stderr || err.message || 'unknown error';
        return { type: 'text', text: `❌ Key rotation failed: ${msg}` };
      }
    },
  });

  // -------------------------------------------------------------------------
  // Tool: squad_identity_lease_token (COORDINATOR USE ONLY)
  // -------------------------------------------------------------------------

  session.registerTool({
    name: 'squad_identity_lease_token',
    description: 'Issue a scoped token lease for an agent role (coordinator use only)',
    inputSchema: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          description: 'Role slug to issue a token lease for (e.g., "backend", "frontend").',
        },
        maxOps: {
          type: 'number',
          description: 'Maximum number of operations allowed under this lease. Default: 3.',
        },
        maxTime: {
          type: 'number',
          description: 'Maximum lease duration in seconds. Default: 300.',
        },
      },
      required: ['role'],
    },
    handler: async (input) => {
      try {
        const leaseScript = join(LIB_DIR, 'token-lease.mjs');
        const maxOps = input.maxOps ?? 3;
        const maxTime = input.maxTime ?? 300;

        const { stdout, stderr } = await execFileAsync(
          process.execPath,
          [leaseScript, '--role', input.role, '--max-ops', String(maxOps), '--max-time', String(maxTime)],
          { cwd: REPO_ROOT, timeout: 15000 }
        );
        if (stderr) session.log(`[squad-identity] lease-token stderr: ${stderr}`);
        return { type: 'text', text: stdout?.trim() || 'No output.' };
      } catch (err) {
        const msg = err.stderr || err.message || 'unknown error';
        return { type: 'text', text: `❌ Token lease failed: ${msg}` };
      }
    },
  });

  // -------------------------------------------------------------------------
  // Tool: squad_identity_attest_write
  // -------------------------------------------------------------------------

  session.registerTool({
    name: 'squad_identity_attest_write',
    description: 'Record and verify an attestation for a bot-authored GitHub write',
    inputSchema: {
      type: 'object',
      properties: {
        owner: {
          type: 'string',
          description: 'GitHub repository owner (user or org).',
        },
        repo: {
          type: 'string',
          description: 'GitHub repository name.',
        },
        writeType: {
          type: 'string',
          description: 'Type of write operation (e.g., "pr", "comment", "push", "label").',
        },
        writeRef: {
          type: 'string',
          description: 'Reference to the write (e.g., PR number, commit SHA).',
        },
        roleSlug: {
          type: 'string',
          description: 'Role slug of the agent that performed the write.',
        },
        expectedActor: {
          type: 'string',
          description: 'Expected GitHub actor (e.g., "sqd-backend[bot]").',
        },
        token: {
          type: 'string',
          description: 'GitHub token used for the write operation.',
        },
        verify: {
          type: 'boolean',
          description: 'Whether to verify the attestation after recording. Default: true.',
        },
      },
      required: ['owner', 'repo', 'writeType', 'writeRef', 'roleSlug', 'expectedActor', 'token'],
    },
    handler: async (input) => {
      try {
        const attestScript = join(LIB_DIR, 'attest-write.mjs');
        const verify = input.verify ?? true;

        const args = [
          attestScript,
          '--repo-root', REPO_ROOT,
          '--owner', input.owner,
          '--repo', input.repo,
          '--write-type', input.writeType,
          '--write-ref', input.writeRef,
          '--role-slug', input.roleSlug,
          '--expected-actor', input.expectedActor,
          '--token', input.token,
        ];
        if (!verify) args.push('--no-verify');

        const { stdout, stderr } = await execFileAsync(
          process.execPath,
          args,
          { cwd: REPO_ROOT, timeout: 15000 }
        );
        if (stderr) session.log(`[squad-identity] attest-write stderr: ${stderr}`);
        return { type: 'text', text: stdout?.trim() || 'No output.' };
      } catch (err) {
        const msg = err.stderr || err.message || 'unknown error';
        return { type: 'text', text: `❌ Attestation failed: ${msg}` };
      }
    },
  });

});
